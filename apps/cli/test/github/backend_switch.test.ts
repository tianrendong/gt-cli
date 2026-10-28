import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync, spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import {
  Repository,
  backupDatabase,
  nativeRows,
  sqlite,
  nativeDigest,
} from '../../src/lib/switch/repository';
import {
  commitNativeRows,
  stopIsolatedNativeHelpers,
} from '../../src/lib/switch/native';
import { switchBackend } from '../../src/lib/switch/transition';
import { switchGlobal } from '../../src/lib/switch/batch';
import {
  BindingUpgradeError,
  upgradeBindings,
} from '../../src/lib/switch/upgrade';
import { planLauncher } from '../../src/lib/switch/launcher';
import { StackStore } from '../../src/lib/github/stack_file';
import { fileLock, FileLockBusyError } from '../../src/lib/github/file_lock';
import { version } from '../../package.json';

chai.use(chaiAsPromised);

const manager = path.resolve(__dirname, '../../src/switch_cli.js');
const cli = path.resolve(__dirname, '../../src/index.js');
const toggle = path.resolve(__dirname, '../../src/toggle_cli.js');
const native = [
  process.env.GT_NATIVE_GRAPHITE,
  '/opt/homebrew/bin/gt',
  '/usr/local/bin/gt',
].find((file) => {
  if (!file || !fs.existsSync(file)) return false;
  const result = spawnSync(file, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return result.status === 0 && result.stdout.trim() === '1.8.6';
});
const candidate = { node: process.execPath, script: manager };

(native ? describe : describe.skip)(
  'reversible backend switch with native Graphite 1.8.6',
  function () {
    this.timeout(120_000);
    let root: string, repo: string, db: string, env: NodeJS.ProcessEnv;
    let originalHeads: string, originalVersion: string;
    const git = (args: string[], input?: string, cwd = repo): string =>
      execFileSync('git', args, {
        cwd,
        env,
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    const run = (args: string[], expected = 0, cwd = repo): string => {
      const result = spawnSync(process.execPath, [manager, ...args], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 90_000,
      });
      expect(
        result.status,
        args.join(' ') + '\n' + result.stdout + result.stderr
      ).to.equal(expected);
      return result.stdout + result.stderr;
    };
    const backend = (): string => JSON.parse(run(['backend', '--json'])).mode;
    const heads = (): string => git(['show-ref', '--heads']);
    const meta = (name: string): Record<string, any> =>
      JSON.parse(git(['cat-file', '-p', `refs/branch-metadata/${name}`]));
    const nodeCommand = (args: string[], expected = 0): string =>
      run(['--no-interactive', ...args], expected);
    const enable = (args: string[] = []): string =>
      run(['enable', '--graphite', native as string, ...args]);
    const state = (): Record<string, any> => {
      const active = path.join(repo, '.git/gt-gh-switch/state.json');
      return JSON.parse(
        fs.readFileSync(
          fs.existsSync(active)
            ? active
            : path.join(repo, '.git/gt-gh-switch/last.json'),
          'utf8'
        )
      );
    };
    const options = () => ({ repo, graphite: native, candidate });
    const script = (
      kind: 'enable' | 'disable',
      args: string[] = [],
      expected = 0,
      cwd = repo
    ): string => {
      const result = spawnSync(process.execPath, [toggle, kind, ...args], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 90_000,
      });
      expect(result.status, result.stdout + result.stderr).to.equal(expected);
      return result.stdout + result.stderr;
    };
    const gt = (args: string[], expected = 0, cwd = repo): string => {
      const result = spawnSync('gt', args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 90_000,
      });
      expect(result.status, result.stdout + result.stderr).to.equal(expected);
      return result.stdout + result.stderr;
    };

    const freshRepository = (name: string): string => {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      const localGit = (args: string[]) => git(args, undefined, directory);
      localGit(['init', '-b', 'main']);
      localGit(['config', 'user.name', 'Test']);
      localGit(['config', 'user.email', 'test@example.invalid']);
      fs.writeFileSync(path.join(directory, 'README'), 'initial\n');
      localGit(['add', '.']);
      localGit(['commit', '-m', 'initial']);
      // Handoff tests use already-initialized standalone repositories. First-use
      // inspection no longer creates setup; fresh-selector cases are separate.
      execFileSync(
        process.execPath,
        [cli, 'init', '--trunk', 'main', '--no-interactive'],
        { cwd: directory, env, stdio: 'pipe' }
      );
      return directory;
    };

    const staleBinding = (cwd = repo): string => {
      const file = path.join(cwd, '.git/gt-gh-switch/state.json');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      value.candidate.node = '/missing/previous-runtime';
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const real = (file: string): string => fs.realpathSync(file);
    const upgrade = async (finish = () => {}, beforeChange = () => {}) => {
      const oldEnv = { ...process.env };
      try {
        Object.assign(process.env, env);
        return await upgradeBindings({
          slot: path.join(root, 'bin/gt'),
          candidate: { node: process.execPath, script: cli },
          dispatcher: path.join(path.dirname(cli), 'gt_cli.js'),
          finish,
          beforeChange,
        });
      } finally {
        for (const key of Object.keys(process.env))
          if (!(key in oldEnv)) delete process.env[key];
        Object.assign(process.env, oldEnv);
      }
    };

    it('submits to GitHub first and retries optional Graphite mirroring without duplicate PRs or native writes', () => {
      const server = JSON.parse(fs.readFileSync(env.GT_FAKE_GITHUB!, 'utf8'));
      server.prs.forEach((pr: any) => {
        pr.id = `PR_${pr.number}`;
      });
      fs.writeFileSync(env.GT_FAKE_GITHUB!, JSON.stringify(server));
      script('enable');
      git(['config', '--local', 'gt.submitGraphite', 'true']);
      const cloudFile = path.join(root, 'graphite-cloud.json');
      fs.writeFileSync(
        cloudFile,
        JSON.stringify({ requests: [], failPr: server.next, remaining: 1 })
      );
      const preload = path.resolve(
        __dirname,
        '../../../test/fixtures/fake-graphite.cjs'
      );
      env.GT_FAKE_GRAPHITE = cloudFile;
      env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
      env.NO_PROXY = 'api.graphite.com';
      delete env.GT_GRAPHITE_TOKEN;
      const submit = [
        'submit',
        '--stack',
        '--no-edit',
        '--draft',
        '--no-interactive',
      ];
      const nativeBefore = fs.readFileSync(db);
      expect(gt([...submit, '--dry-run'])).to.contain(
        'No Graphite request in dry-run'
      );
      expect(
        JSON.parse(fs.readFileSync(cloudFile, 'utf8')).requests
      ).to.have.length(0);
      expect(gt(submit, 1)).to.contain('Graphite authentication is missing');
      expect(
        JSON.parse(fs.readFileSync(env.GT_FAKE_GITHUB!, 'utf8')).prs
      ).to.have.length(server.prs.length);
      env.GT_GRAPHITE_TOKEN = 'fixture-token';
      expect(gt(submit, 1)).to.contain(
        'GitHub submission completed, but Graphite mirroring is incomplete (1/2)'
      );
      const published = JSON.parse(
        fs.readFileSync(env.GT_FAKE_GITHUB!, 'utf8')
      );
      expect(published.prs).to.have.length(2);
      expect(published.stacks).to.have.length(1);
      const ids = published.prs.map((pr: any) => pr.id);
      expect(meta('one').lastSubmittedVersion.headSha).to.equal(
        git(['rev-parse', 'one'])
      );
      const metadata = git([
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/branch-metadata',
      ]);
      expect(gt(submit)).to.contain('Graphite: 2 open PRs synchronized');
      const retried = JSON.parse(fs.readFileSync(env.GT_FAKE_GITHUB!, 'utf8'));
      expect(retried.prs.map((pr: any) => pr.id)).to.deep.equal(ids);
      expect(retried.stacks).to.deep.equal(published.stacks);
      // Graphite receives parent-ordered singleton requests; retry the failed
      // child only. The old batched expectation predates the production fix.
      expect(
        JSON.parse(fs.readFileSync(cloudFile, 'utf8')).requests.map((r: any) =>
          r.prs.map((pr: any) => pr.prNumber)
        )
      ).to.deep.equal([[server.prs[0].number], [server.next], [server.next]]);
      expect(
        git([
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/branch-metadata',
        ])
      ).to.equal(metadata);
      expect(fs.readFileSync(db).equals(nativeBefore)).to.equal(true);
      expect(heads()).to.equal(originalHeads);
    });

    it('updates every enabled binding without turning on global mode or changing native data', async () => {
      script('enable');
      const second = freshRepository('second');
      script('enable', [], 0, second);
      const firstFile = staleBinding(),
        secondFile = staleBinding(second);
      const bytes = fs.readFileSync(db),
        index = fs.readFileSync(path.join(repo, '.git/index'));
      const result = await upgrade();
      expect(result.global).to.equal(false);
      expect(result.repositories).to.have.length(2);
      for (const file of [firstFile, secondFile])
        expect(
          JSON.parse(fs.readFileSync(file, 'utf8')).candidate.node
        ).to.equal(process.execPath);
      expect(fs.readFileSync(db).equals(bytes)).to.equal(true);
      expect(
        fs.readFileSync(path.join(repo, '.git/index')).equals(index)
      ).to.equal(true);
      expect(heads()).to.equal(originalHeads);
      expect(gt(['--version'], 0, root).trim()).to.equal('1.8.6');
    });
    it('preserves global default and explicit native opt-outs during updates', async () => {
      script('enable');
      script('enable', ['--global'], 0, root);
      const optedOut = freshRepository('native-opt-out');
      script('disable', [], 0, optedOut);
      const optOut = path.join(optedOut, '.git/gt-gh-switch/last.json');
      const before = fs.readFileSync(optOut);
      staleBinding();
      expect((await upgrade()).global).to.equal(true);
      expect(fs.readFileSync(optOut).equals(before)).to.equal(true);
      expect(gt(['--version'], 0, optedOut).trim()).to.equal('1.8.6');
      expect(gt(['--version'], 0, root).trim()).to.equal(version);
    });
    it('checks the installation pointer before changing the first binding', async () => {
      script('enable');
      const file = staleBinding(),
        before = fs.readFileSync(file);
      const failure = await upgrade(
        () => {},
        () => {
          throw Error('another installation replaced current');
        }
      ).catch((error) => error);
      expect(failure).to.be.instanceOf(BindingUpgradeError);
      expect(failure.updatePhase).to.equal('preflight');
      expect(fs.readFileSync(file).equals(before)).to.equal(true);
    });
    it('defers a repository with an in-flight operation and still refreshes the others', async () => {
      script('enable');
      const second = freshRepository('zzz-second');
      script('enable', [], 0, second);
      const firstFile = staleBinding(),
        secondFile = staleBinding(second);
      const before = fs.readFileSync(secondFile);
      let finished = false;
      fs.writeFileSync(path.join(second, '.git/.gtcontinue'), '{}');
      const result = await upgrade(() => {
        finished = true;
      });
      expect(finished).to.equal(true);
      expect(result.repositories.map(real)).to.deep.equal([real(repo)]);
      expect(result.deferred).to.have.length(1);
      expect(result.deferred[0].repository).to.equal(
        fs.realpathSync(path.join(second, '.git'))
      );
      expect(result.deferred[0].reason).to.match(/Finish or abort/);
      expect(result.deferred[0].reason).to.contain('.gtcontinue');
      expect(
        JSON.parse(fs.readFileSync(firstFile, 'utf8')).candidate.node
      ).to.equal(process.execPath);
      expect(fs.readFileSync(secondFile).equals(before)).to.equal(true);
      expect(gt(['--version'], 0, root).trim()).to.equal('1.8.6');
      // The deferred repository catches up once its operation is finished.
      fs.unlinkSync(path.join(second, '.git/.gtcontinue'));
      const retry = await upgrade();
      expect(retry.repositories.map(real)).to.deep.equal([real(second)]);
      expect(retry.deferred).to.deep.equal([]);
      expect(
        JSON.parse(fs.readFileSync(secondFile, 'utf8')).candidate.node
      ).to.equal(process.execPath);
    });
    for (const location of ['moved', 'restored']) {
      it(`auto-forgets an absent checkout and re-registers it when ${location}, catching up on first gt use`, async () => {
        script('enable');
        const second = freshRepository('missing');
        script('enable', [], 0, second);
        const common = real(path.join(second, '.git'));
        staleBinding();
        staleBinding(second);
        const moved = second + '-moved';
        fs.renameSync(second, moved);
        const result = await upgrade();
        expect(result.repositories.map(real)).to.deep.equal([real(repo)]);
        expect(result.deferred).to.deep.equal([]);
        expect(result.forgotten.map((entry) => entry.repository)).to.deep.equal(
          [common]
        );
        expect(result.forgotten[0]).to.deep.equal({ repository: common });
        expect(
          JSON.parse(script('enable', ['--global', '--status'], 0, root))
            .repositories
        ).not.to.include(common);
        const returned = location === 'restored' ? second : moved;
        if (location === 'restored') fs.renameSync(moved, second);
        // The returned repo still selects gt-gh, but its old pinned runtime is
        // unavailable. Re-registration queues/refreshes the installed bundle.
        expect(gt(['--version'], 0, returned).trim()).to.equal(version);
        const status = JSON.parse(
          script('enable', ['--global', '--status'], 0, root)
        );
        expect(status.repositories).to.include(
          real(path.join(returned, '.git'))
        );
        if (location === 'moved')
          expect(status.repositories).not.to.include(common);
        expect(status.mode).to.equal('graphite'); // no change to global default
        const selected = JSON.parse(
          fs.readFileSync(
            path.join(returned, '.git/gt-gh-switch/state.json'),
            'utf8'
          )
        );
        expect(selected.candidate.node).to.equal(process.execPath);
        expect(selected.mode).to.equal('gt-gh');
        expect(state().candidate.node).to.equal(process.execPath);
      });
    }
    it('re-enrolls a returned checkout but preserves its pin while busy or native metadata has drifted', async () => {
      script('enable');
      const second = freshRepository('returned');
      script('enable', [], 0, second);
      const oldNode = path.join(root, 'old-node');
      fs.symlinkSync(process.execPath, oldNode);
      const selection = '.git/gt-gh-switch/state.json';
      const selected = JSON.parse(
        fs.readFileSync(path.join(second, selection), 'utf8')
      );
      selected.candidate.node = oldNode;
      fs.writeFileSync(path.join(second, selection), JSON.stringify(selected));
      const moved = second + '-moved';
      fs.renameSync(second, moved);
      expect((await upgrade()).forgotten).to.have.length(1);
      fs.writeFileSync(path.join(moved, '.git/.gtcontinue'), '{}');
      expect(gt(['--version'], 0, moved).trim()).to.equal(version);
      const pinned = () =>
        JSON.parse(fs.readFileSync(path.join(moved, selection), 'utf8'));
      expect(pinned()).to.deep.equal(selected);
      expect(
        JSON.parse(script('enable', ['--global', '--status'], 0, root))
          .repositories
      ).to.include(real(path.join(moved, '.git')));
      fs.unlinkSync(path.join(moved, '.git/.gtcontinue'));
      const config = path.join(moved, '.git/.graphite_repo_config');
      const original = fs.existsSync(config)
        ? fs.readFileSync(config)
        : undefined;
      fs.writeFileSync(config, 'fixture native metadata drift');
      expect(gt(['--version'], 0, moved)).to.contain(
        'Graphite metadata changed outside gt-gh'
      );
      expect(pinned()).to.deep.equal(selected);
      expect(fs.readFileSync(config, 'utf8')).to.equal(
        'fixture native metadata drift'
      );
      if (original) fs.writeFileSync(config, original);
      else fs.unlinkSync(config);
      expect(gt(['--version'], 0, moved).trim()).to.equal(version);
      expect(pinned().candidate.node).to.equal(process.execPath);
      expect(heads()).to.equal(originalHeads);
    });
    it('global disable previews auto-cleanup, then forgets deleted checkouts and hands live ones back', () => {
      script('enable');
      const gone = ['gone-a', 'gone-b'].map((name) => {
        const directory = freshRepository(name);
        script('enable', [], 0, directory);
        const common = real(path.join(directory, '.git'));
        fs.rmSync(directory, { recursive: true });
        return common;
      });
      const file = path.join(repo, '.git/gt-gh-switch/state.json');
      const before = fs.readFileSync(file);
      const preview = JSON.parse(
        script('disable', ['--global', '--dry-run', '--json'], 0, root)
      );
      expect(
        preview.forgotten.map((entry: any) => entry.repository).sort()
      ).to.deep.equal([...gone].sort());
      expect(preview.forgotten.every((entry: any) => !entry.backup)).to.equal(
        true
      );
      expect(fs.readFileSync(file).equals(before)).to.equal(true);
      const status = JSON.parse(
        script('enable', ['--global', '--status'], 0, root)
      );
      for (const common of gone) expect(status.repositories).to.include(common);
      const output = script('disable', ['--global'], 0, root);
      for (const common of gone)
        expect(output).to.contain(`Forgot missing checkout: ${common}`);
      expect(output).not.to.contain('Registration backup:');
      expect(output).to.contain('Native gt PATH entry restored.');
      expect(gt(['--version'], 0, repo).trim()).to.equal('1.8.6');
      expect(heads()).to.equal(originalHeads);
    });
    it('defers a damaged registered Git directory and keeps its registration', async () => {
      script('enable');
      const second = freshRepository('damaged');
      script('enable', [], 0, second);
      const file = path.join(second, '.git/gt-gh-switch/state.json');
      staleBinding();
      staleBinding(second);
      const before = fs.readFileSync(file);
      const common = path.join(second, '.git');
      fs.unlinkSync(path.join(common, 'HEAD'));
      const result = await upgrade();
      expect(result.repositories.map(real)).to.deep.equal([real(repo)]);
      expect(result.deferred).to.have.length(1);
      expect(result.deferred[0].kind).to.equal('blocked');
      expect(result.deferred[0].reason).to.contain(
        'Git cannot read this registered repository'
      );
      expect(result.deferred[0].reason).to.contain(common);
      expect(result.deferred[0].reason).not.to.contain('Command failed:');
      expect(fs.readFileSync(file).equals(before)).to.equal(true);
      expect(fs.existsSync(common)).to.equal(true);
      expect(
        JSON.parse(
          script('enable', ['--global', '--status', '--json'], 0, root)
        ).repositories
      ).to.include(fs.realpathSync(common));
    });
    it('defers a repository whose lock stays busy instead of failing the update', async () => {
      script('enable');
      const second = freshRepository('busy');
      script('enable', [], 0, second);
      const file = staleBinding(),
        secondFile = staleBinding(second);
      const before = fs.readFileSync(secondFile);
      const store = await StackStore.open(
        path.join(second, '.git'),
        path.join(second, '.git')
      );
      try {
        const result = await upgrade();
        expect(result.repositories.map(real)).to.deep.equal([real(repo)]);
        expect(result.deferred).to.have.length(1);
        expect(result.deferred[0].reason).to.contain(
          'command is still running'
        );
        expect(fs.readFileSync(secondFile).equals(before)).to.equal(true);
        expect(
          JSON.parse(fs.readFileSync(file, 'utf8')).candidate.node
        ).to.equal(process.execPath);
      } finally {
        store.close();
      }
      const retry = await upgrade();
      expect(retry.repositories.map(real)).to.deep.equal([real(second)]);
      expect(retry.deferred).to.deep.equal([]);
    });
    it('retries a late activation failure without rolling back work done on the new bindings', async () => {
      script('enable');
      staleBinding();
      const failure = await upgrade(() => {
        throw Error('injected final pointer failure');
      }).catch((error) => error);
      expect(failure).to.be.instanceOf(BindingUpgradeError);
      expect(failure.message).to.contain('injected final pointer failure');
      expect(failure.updatePhase).to.equal('activation');
      expect(state().candidate.node).to.equal(process.execPath);
      git(['commit', '--allow-empty', '-m', 'work after partial update']);
      const after = heads();
      expect((await upgrade()).repositories).to.deep.equal([]);
      expect(heads()).to.equal(after);
    });
    it('defers common-lock contention and catches up on the next idle gt invocation', async () => {
      script('enable');
      const file = staleBinding(),
        before = fs.readFileSync(file);
      const store = await StackStore.open(
        path.join(repo, '.git'),
        path.join(repo, '.git'),
        Infinity,
        { repositoryLock: true }
      );
      const inode = fs.statSync(path.join(repo, '.git/gt.lock')).ino;
      try {
        const result = await upgrade();
        expect(result.deferred).to.have.length(1);
        expect(fs.readFileSync(file).equals(before)).to.equal(true);
      } finally {
        store.close();
      }
      expect(gt(['--version']).trim()).to.equal(version);
      expect(state().candidate.node).to.equal(process.execPath);
      expect(fs.statSync(path.join(repo, '.git/gt.lock')).ino).to.equal(inode);
    });

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-switch-test-'));
      repo = path.join(root, 'repo');
      db = path.join(repo, '.git/.graphite_metadata.db');
      fs.mkdirSync(repo);
      fs.mkdirSync(path.join(root, 'home'));
      fs.mkdirSync(path.join(root, 'bin'));
      // Every installer test owns its PATH slot. Never replace Homebrew's gt.
      fs.symlinkSync(native as string, path.join(root, 'bin/gt'));
      fs.writeFileSync(path.join(root, 'bin/brew'), '#!/bin/sh\nexit 1\n', {
        mode: 0o755,
      });
      const fixture = path.resolve(
        __dirname,
        '../../../test/fixtures/fake-gh.cjs'
      );
      fs.copyFileSync(fixture, path.join(root, 'bin/gh'));
      fs.chmodSync(path.join(root, 'bin/gh'), 0o755);
      env = {
        ...process.env,
        HOME: path.join(root, 'home'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_STATE_HOME: path.join(root, 'state'),
        PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        HOMEBREW_NO_AUTO_UPDATE: '1',
        GRAPHITE_DISABLE_TELEMETRY: '1',
        GRAPHITE_DISABLE_UPGRADE_PROMPT: '1',
        GRAPHITE_DISABLE_SURVEY: '1',
        GIT_EDITOR: 'true',
        GT_EDITOR: 'true',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        GT_FAKE_GITHUB: path.join(root, 'github.json'),
        GRAPHITE_USER_CONFIG_PATH: path.join(
          repo,
          '.git/.graphite_user_config'
        ),
      };
      delete env.GRAPHITE_INTERACTIVE;
      git(['init', '-b', 'main']);
      git(['config', 'user.name', 'Test']);
      git(['config', 'user.email', 'test@example.com']);
      fs.writeFileSync(path.join(repo, 'README'), 'initial\n');
      git(['add', '.']);
      git(['commit', '-m', 'initial']);
      const main = git(['rev-parse', 'HEAD']);
      git(['checkout', '-b', 'one']);
      fs.writeFileSync(path.join(repo, 'one.txt'), 'one\n');
      git(['add', '.']);
      git(['commit', '-m', 'one']);
      const one = git(['rev-parse', 'HEAD']);
      git(['checkout', '-b', 'two']);
      fs.writeFileSync(path.join(repo, 'two.txt'), 'two\n');
      git(['add', '.']);
      git(['commit', '-m', 'two']);
      const origin = path.join(root, 'origin.git');
      git(['init', '--bare', origin]);
      git(['remote', 'add', 'origin', origin]);
      git(['push', '-u', 'origin', 'main', 'one', 'two']);
      git(['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      fs.writeFileSync(
        path.join(repo, '.git/.graphite_repo_config'),
        JSON.stringify({
          trunk: 'main',
          trunks: [{ name: 'main' }],
          host: 'github.com',
          owner: 'test',
          name: 'repo',
          lastFetchedPRInfoMs: Date.now(),
          lastFetchedFeatureFlagsInMs: Date.now(),
        })
      );
      fs.writeFileSync(
        path.join(repo, '.git/.graphite_user_config'),
        JSON.stringify({ tips: false })
      );
      fs.writeFileSync(
        path.join(repo, '.git/.graphite_pr_info'),
        JSON.stringify({ prInfos: [], mergeabilityStatuses: [] })
      );
      for (const [branch, parent, base] of [
        ['one', 'main', main],
        ['two', 'one', one],
      ]) {
        const metadata = {
          parentBranchName: parent,
          parentBranchRevision: base,
          ...(branch === 'one'
            ? {
                lastSubmittedVersion: {
                  headSha: one,
                  baseSha: main,
                  baseName: 'main',
                  versionNumber: 3,
                },
              }
            : {}),
        };
        git([
          'update-ref',
          `refs/branch-metadata/${branch}`,
          git(['hash-object', '-w', '--stdin'], JSON.stringify(metadata)),
        ]);
      }
      const result = spawnSync(
        native as string,
        ['--cwd', repo, '--no-interactive', 'log', 'short', '--all'],
        { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }
      );
      expect(result.status, result.stdout + result.stderr).to.equal(0);
      await sleep(150);
      for (const branch of ['one', 'two'])
        git(['update-ref', '-d', `refs/branch-metadata/${branch}`]);
      fs.writeFileSync(
        path.join(repo, '.git/.graphite_pr_info'),
        JSON.stringify({
          prInfos: [
            {
              headRefName: 'one',
              prNumber: 42,
              baseRefName: 'main',
              state: 'OPEN',
              isDraft: true,
              title: 'One',
              body: 'Preserve body',
              url: 'https://github.com/test/repo/pull/42',
              versions: [],
              cliTrunk: 'main',
            },
          ],
          mergeabilityStatuses: [],
        })
      );
      fs.writeFileSync(
        env.GT_FAKE_GITHUB as string,
        JSON.stringify({
          gitDir: origin,
          next: 100,
          calls: [],
          prs: [
            {
              number: 42,
              headRefName: 'one',
              baseRefName: 'main',
              title: 'One',
              body: 'Preserve body',
              state: 'OPEN',
              isDraft: true,
            },
          ],
          stacks: [],
        })
      );
      originalHeads = heads();
      originalVersion = nativeRows(db).find((r) => r.branch_name === 'one')!
        .last_submitted_version!;
    });
    afterEach(() => {
      stopIsolatedNativeHelpers(root, native as string);
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });

    it('switches the same gt executable for an already-running consumer and restores it', async () => {
      const slot = path.join(root, 'bin/gt'),
        original = fs.readlinkSync(slot),
        originalPath = env.PATH;
      const consumer = spawn(
        process.execPath,
        [
          '-e',
          `const cp=require('child_process');process.on('message',args=>{const r=cp.spawnSync('gt',args,{encoding:'utf8'});process.send({status:r.status,stdout:r.stdout,stderr:r.stderr});});`,
        ],
        { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
      );
      const invoke = (args: string[]) =>
        new Promise<string>((resolve, reject) => {
          consumer.once(
            'message',
            (result: { status: number; stdout: string; stderr: string }) =>
              result.status === 0
                ? resolve(result.stdout)
                : reject(new Error(result.stderr))
          );
          consumer.send(args);
        });
      try {
        expect((await invoke(['--version'])).trim()).to.equal('1.8.6');
        script('enable');
        expect(fs.readlinkSync(slot)).not.to.equal(original);
        expect((await invoke(['--version'])).trim()).to.equal(version);
        expect(env.PATH).to.equal(originalPath);
        expect(await invoke(['info', 'main'])).to.contain('initial');
        await invoke([
          '--no-interactive',
          'move',
          '--source',
          'two',
          '--onto',
          'main',
        ]);
        const current = heads();
        script('disable');
        expect(fs.readlinkSync(slot)).to.equal(original);
        expect((await invoke(['--version'])).trim()).to.equal('1.8.6');
        expect(await invoke(['--no-interactive', 'info', 'two'])).to.contain(
          'Parent: main'
        );
        expect(heads()).to.equal(current);
      } finally {
        const exited = new Promise((resolve) => consumer.once('exit', resolve));
        consumer.kill();
        await exited;
      }
    });

    for (const shell of ['/bin/bash', '/bin/zsh'].filter((file) =>
      fs.existsSync(file)
    )) {
      it(`switches an already-hashed gt command in ${shell} without rehashing`, () => {
        const enableScript = path.resolve(__dirname, '../../../enable.sh');
        const disableScript = path.resolve(__dirname, '../../../disable.sh');
        const output = execFileSync(
          shell,
          [
            '-c',
            'set -e; hash gt; gt --version; "$1" --json >/dev/null; gt --version; "$2" --json >/dev/null; gt --version',
            'gt-switch-test',
            enableScript,
            disableScript,
          ],
          { cwd: repo, env, encoding: 'utf8', timeout: 90_000 }
        );
        expect(output.trim().split('\n')).to.deep.equal([
          '1.8.6',
          version,
          '1.8.6',
        ]);
        expect(fs.readlinkSync(path.join(root, 'bin/gt'))).to.equal(native);
      });
    }

    it('global mode migrates native metadata on first use without changing branch tips or the native database', () => {
      const initialDb = nativeDigest(db);
      const slot = path.join(root, 'bin/gt');
      script('enable', ['--global', '--dry-run'], 0, root);
      expect(fs.readlinkSync(slot)).to.equal(native);
      expect(fs.existsSync(env.XDG_STATE_HOME!)).to.equal(false);
      script('enable', ['--global'], 0, root);
      expect(gt(['--version'], 0, root).trim()).to.equal(version);
      expect(gt(['--cwd', repo, '--version'], 0, root).trim()).to.equal(
        version
      );
      expect(JSON.parse(gt(['--capabilities'])).migrationRequired).to.equal(
        true
      );
      expect(gt(['info'])).to.contain('Parent: one');
      expect(JSON.parse(gt(['--capabilities'])).migrationRequired).to.equal(
        undefined
      );
      expect(heads()).to.equal(originalHeads);
      expect(nativeDigest(db)).to.equal(initialDb);
      const state = JSON.parse(
        fs.readFileSync(path.join(repo, '.git/gt-gh-switch/state.json'), 'utf8')
      );
      expect(state.mode).to.equal('gt-gh');
      expect(
        fs.existsSync(
          path.join(
            repo,
            '.git/gt-gh-switch/sessions',
            state.session,
            'before.sqlite'
          )
        )
      ).to.equal(true);
      script('disable', ['--global'], 0, root);
      expect(fs.readlinkSync(slot)).to.equal(native);
    });

    it('unsafe first-use native migration fails before changing refs and can be explicitly opted out', () => {
      sqlite(
        db,
        `UPDATE branch_metadata SET last_submitted_version='{"headSha":"${git([
          'rev-parse',
          'one',
        ])}"}' WHERE branch_name='one';`,
        false
      );
      const before = nativeDigest(db);
      script('enable', ['--global'], 0, root);
      expect(gt(['info'], 1)).to.contain('complete matching published version');
      expect(nativeDigest(db)).to.equal(before);
      expect(heads()).to.equal(originalHeads);
      expect(
        fs.existsSync(path.join(repo, '.git/gt-gh-switch/state.json'))
      ).to.equal(false);
      script('disable', ['--repo', repo]);
      expect(gt(['--version']).trim()).to.equal('1.8.6');
      expect(gt(['--version'], 0, root).trim()).to.equal(version);
      script('disable', ['--global'], 0, root);
    });

    it('repo enable adopts an initialized Git repo without requiring native initialization', () => {
      const fresh = freshRepository('fresh');
      const before = git(['show-ref', '--heads'], undefined, fresh);
      script('enable', ['--repo', fresh]);
      expect(gt(['--version'], 0, fresh).trim()).to.equal(version);
      gt(['info', 'main'], 0, fresh);
      script('disable', ['--repo', fresh]);
      expect(gt(['--version'], 0, fresh).trim()).to.equal('1.8.6');
      expect(git(['show-ref', '--heads'], undefined, fresh)).to.equal(before);
    });

    it('global disable hands healthy repositories back and warns on paused ones without trapping users', () => {
      script('enable');
      const fresh = freshRepository('fresh');
      script('enable', ['--repo', fresh]);
      gt(['info', 'main'], 0, fresh);
      script('enable', ['--global'], 0, root);
      const dbBefore = nativeDigest(db),
        stateBefore = fs.readFileSync(
          path.join(repo, '.git/gt-gh-switch/state.json')
        );
      fs.writeFileSync(path.join(fresh, '.git/.gtcontinue'), '{}');
      const output = script('disable', ['--global'], 0, root);
      expect(output.toLowerCase()).to.contain('finish or abort');
      expect(output).to.contain('WARNING:');
      expect(state().mode).to.equal('graphite');
      expect(
        fs
          .readFileSync(path.join(repo, '.git/gt-gh-switch/last.json'))
          .equals(stateBefore)
      ).to.equal(false);
      expect(nativeDigest(db)).to.equal(dbBefore);
      expect(
        fs.existsSync(path.join(fresh, '.git/.graphite_metadata.db'))
      ).to.equal(false);
      expect(
        JSON.parse(script('enable', ['--global', '--status'], 0, root)).mode
      ).to.equal('graphite');
      fs.unlinkSync(path.join(fresh, '.git/.gtcontinue'));
      script('disable', ['--global'], 0, root);
      // Once native routing has been selected, retry must not export stale clone
      // state over subsequent native work, even after the original blocker clears.
      expect(
        fs.existsSync(path.join(fresh, '.git/.graphite_metadata.db'))
      ).to.equal(false);
      expect(gt(['--version'], 0, repo).trim()).to.equal('1.8.6');
      expect(gt(['--version'], 0, fresh).trim()).to.equal('1.8.6');
      expect(fs.readlinkSync(path.join(root, 'bin/gt'))).to.equal(native);
      expect(heads()).to.equal(originalHeads);
    });

    it('global disable preserves completed handoffs and resumes a late interrupted repository', async () => {
      script('enable');
      const fresh = freshRepository('fresh');
      script('enable', ['--repo', fresh]);
      gt(['info', 'main'], 0, fresh);
      script('enable', ['--global'], 0, root);
      const oldEnv = { ...process.env },
        apply = Repository.prototype.applyFile;
      let message = '';
      try {
        Object.assign(process.env, env);
        Repository.prototype.applyFile = function (
          this: Repository,
          ...args: Parameters<Repository['applyFile']>
        ) {
          if (fs.realpathSync(this.cwd) === fs.realpathSync(fresh))
            throw Error('injected late global handoff');
          return apply.apply(this, args);
        };
        try {
          await switchGlobal('disable', {
            initial: planLauncher(),
            candidate: { node: process.execPath, script: cli },
            dispatcher: path.join(path.dirname(cli), 'gt_cli.js'),
            dryRun: false,
          });
        } catch (error) {
          message = error.message;
        }
      } finally {
        Repository.prototype.applyFile = apply;
        for (const key of Object.keys(process.env))
          if (!(key in oldEnv)) delete process.env[key];
        Object.assign(process.env, oldEnv);
      }
      expect(message).to.contain('injected late global handoff');
      expect(message).to.contain('Completed:');
      expect(state().mode).to.equal('graphite');
      const status = JSON.parse(
        script('enable', ['--global', '--status'], 0, root)
      );
      expect(status.mode).to.equal('graphite');
      expect(status.repositories).to.deep.equal([
        fs.realpathSync(path.join(fresh, '.git')),
      ]);
      script('disable', ['--global'], 0, root);
      expect(fs.readlinkSync(path.join(root, 'bin/gt'))).to.equal(native);
      expect(heads()).to.equal(originalHeads);
    });

    it('global enable refreshes existing candidate runtime bindings without discarding metadata', () => {
      enable();
      const previous = state();
      // Legacy entry records point at switch_cli; global enable should bind the
      // chosen installation's index/runtime through the validated idempotent path.
      script('enable');
      const fresh = freshRepository('fresh');
      script('enable', ['--repo', fresh]);
      const lease = meta('one').lastSubmittedVersion;
      const selection = path.join(repo, '.git/gt-gh-switch/state.json');
      fs.writeFileSync(
        selection,
        JSON.stringify({
          ...state(),
          candidate: { script: cli, node: '/missing/old-node' },
        })
      );
      script('enable', ['--global'], 0, root);
      expect(state().candidate.script).to.equal(cli);
      expect(state().candidate.node).to.equal(process.execPath);
      expect(state().session).to.equal(previous.session);
      expect(meta('one').lastSubmittedVersion).to.deep.equal(lease);
      expect(heads()).to.equal(originalHeads);
      script('disable', ['--global'], 0, root);
    });

    it('explicit repo selection overrides the global default', () => {
      script('enable');
      script('enable', ['--global'], 0, root);
      script('disable');
      expect(gt(['--version']).trim()).to.equal('1.8.6');
      expect(gt(['--version'], 0, root).trim()).to.equal(version);
      script('disable', ['--global'], 0, root);
      expect(fs.readlinkSync(path.join(root, 'bin/gt'))).to.equal(native);
    });

    it('global mode adopts new repositories and hands their current work back safely', () => {
      const fresh = freshRepository('fresh');
      const freshGit = (args: string[]) => git(args, undefined, fresh);
      script('enable', ['--global'], 0, root);
      gt(['info', 'main'], 0, fresh);
      fs.writeFileSync(path.join(fresh, 'change'), 'one\n');
      freshGit(['add', '.']);
      gt(['create', 'feature', '-m', 'feature', '--no-interactive'], 0, fresh);
      const selection = path.join(fresh, '.git/gt-gh-switch/state.json');
      expect(
        JSON.parse(fs.readFileSync(selection, 'utf8')).nativeAbsent
      ).to.equal(true);
      const refs = freshGit(['show-ref', '--heads']);
      fs.appendFileSync(path.join(fresh, 'change'), 'staged\n');
      freshGit(['add', '.']);
      fs.appendFileSync(path.join(fresh, 'change'), 'unstaged\n');
      fs.writeFileSync(path.join(fresh, 'untracked'), 'keep\n');
      const index = fs.readFileSync(path.join(fresh, '.git/index'));
      const status = freshGit(['status', '--porcelain=v1']);
      script('disable', ['--global', '--dry-run'], 0, root);
      expect(
        fs.existsSync(path.join(fresh, '.git/.graphite_metadata.db'))
      ).to.equal(false);
      script('disable', ['--global'], 0, root);
      expect(gt(['--version'], 0, root).trim()).to.equal('1.8.6');
      expect(gt(['--version'], 0, fresh).trim()).to.equal('1.8.6');
      expect(fs.readlinkSync(path.join(root, 'bin/gt'))).to.equal(native);
      expect(gt(['info', 'feature'], 0, fresh)).to.contain('Parent: main');
      expect(freshGit(['show-ref', '--heads'])).to.equal(refs);
      expect(
        fs.readFileSync(path.join(fresh, '.git/index')).equals(index)
      ).to.equal(true);
      expect(freshGit(['status', '--porcelain=v1'])).to.equal(status);
      stopIsolatedNativeHelpers(root, native as string);
      script('enable', [], 0, fresh);
      expect(gt(['info', 'feature'], 0, fresh)).to.contain('Parent: main');
      script('disable', [], 0, fresh);
    });

    it('resumes a standalone handoff interrupted after creating the first native database', async () => {
      const fresh = freshRepository('fresh');
      script('enable', ['--global'], 0, root);
      gt(['info', 'main'], 0, fresh);
      const original = Repository.prototype.applyFile;
      try {
        Repository.prototype.applyFile = () => {
          throw new Error('injected after database creation');
        };
        let error: Error | undefined;
        try {
          await switchBackend('disable', { ...options(), repo: fresh });
        } catch (e) {
          error = e;
        }
        expect(error?.message).to.contain('injected after database creation');
      } finally {
        Repository.prototype.applyFile = original;
      }
      expect(
        fs.existsSync(path.join(fresh, '.git/.graphite_metadata.db'))
      ).to.equal(true);
      expect(gt(['info'], 1, fresh)).to.contain('Backend switch is incomplete');
      script('disable', [], 0, fresh);
      expect(gt(['--version'], 0, fresh).trim()).to.equal('1.8.6');
      expect(
        nativeRows(path.join(fresh, '.git/.graphite_metadata.db')).find(
          (row) => row.branch_name === 'main'
        )?.validation_result
      ).to.equal('TRUNK');
      script('disable', ['--global'], 0, root);
    });

    it('will not overwrite native metadata that appears in a globally adopted repository', () => {
      const fresh = freshRepository('fresh');
      script('enable', ['--global'], 0, root);
      gt(['info', 'main'], 0, fresh);
      execFileSync(
        native as string,
        ['--cwd', fresh, '--no-interactive', 'log', 'short'],
        { env, stdio: 'pipe' }
      );
      const freshDb = path.join(fresh, '.git/.graphite_metadata.db');
      const digest = nativeDigest(freshDb);
      expect(script('disable', [], 0, fresh)).to.contain(
        'metadata changed outside'
      );
      expect(nativeDigest(freshDb)).to.equal(digest);
      expect(gt(['--version'], 0, fresh).trim()).to.equal('1.8.6');
    });

    it('standalone handoff preserves PR identity and the last published lease after local amendments', () => {
      const fresh = freshRepository('fresh');
      const localGit = (args: string[]) => git(args, undefined, fresh);
      const origin = path.join(root, 'fresh-origin.git');
      localGit(['init', '--bare', origin]);
      localGit(['remote', 'add', 'origin', origin]);
      localGit(['push', '-u', 'origin', 'main']);
      localGit([
        'config',
        `url.${origin}.insteadOf`,
        'https://github.com/test/repo.git',
      ]);
      localGit([
        'remote',
        'set-url',
        'origin',
        'https://github.com/test/repo.git',
      ]);
      env.GT_FAKE_GITHUB = path.join(root, 'fresh-github.json');
      fs.writeFileSync(
        env.GT_FAKE_GITHUB,
        JSON.stringify({
          gitDir: origin,
          next: 100,
          prs: [],
          stacks: [],
          calls: [],
        })
      );
      script('enable', ['--global'], 0, root);
      gt(['info', 'main'], 0, fresh);
      fs.writeFileSync(path.join(fresh, 'feature.txt'), 'published\n');
      localGit(['add', '.']);
      gt(['create', 'feature', '-m', 'feature', '--no-interactive'], 0, fresh);
      gt(
        ['submit', '--stack', '--dry-run', '--no-edit', '--no-interactive'],
        0,
        fresh
      );
      gt(
        ['submit', '--stack', '--draft', '--no-edit', '--no-interactive'],
        0,
        fresh
      );
      const published = localGit(['rev-parse', 'feature']);
      fs.appendFileSync(path.join(fresh, 'feature.txt'), 'local amendment\n');
      gt(['modify', '--update', '-m', 'amended', '--no-interactive'], 0, fresh);
      const head = localGit(['rev-parse', 'feature']);
      expect(head).not.to.equal(published);
      script('disable', [], 0, fresh);
      const row = nativeRows(
        path.join(fresh, '.git/.graphite_metadata.db')
      ).find((r) => r.branch_name === 'feature')!;
      expect(JSON.parse(row.last_submitted_version!).headSha).to.equal(
        published
      );
      expect(localGit(['rev-parse', 'feature'])).to.equal(head);
      expect(gt(['info', 'feature'], 0, fresh)).to.contain('PR #100');
      script('disable', ['--global'], 0, root);
    });

    it('automatically uses one global adoption record across linked worktrees', () => {
      const fresh = freshRepository('fresh');
      const linked = path.join(root, 'linked-global');
      git(
        ['worktree', 'add', '-b', 'linked', linked, 'main'],
        undefined,
        fresh
      );
      script('enable', ['--global'], 0, root);
      gt(['init', '--trunk', 'main', '--no-interactive'], 0, linked);
      expect(gt(['--version'], 0, fresh).trim()).to.equal(version);
      expect(gt(['--version'], 0, linked).trim()).to.equal(version);
      const global = JSON.parse(
        script('enable', ['--global', '--status'], 0, root)
      );
      expect(global.repositories).to.deep.equal([
        fs.realpathSync(path.join(fresh, '.git')),
      ]);
      script('disable', [], 0, linked);
      expect(gt(['--version'], 0, fresh).trim()).to.equal('1.8.6');
      expect(gt(['--version'], 0, linked).trim()).to.equal('1.8.6');
      script('disable', ['--global'], 0, root);
    });

    it('registers first global use before a concurrent global disable can restore native routing', async () => {
      const fresh = freshRepository('fresh');
      script('enable', ['--global'], 0, root);
      const common = path.join(fresh, '.git');
      const lock = await StackStore.open(common, common);
      const installerRoot = path.join(env.XDG_STATE_HOME!, 'gt-gh/launchers');
      const fd = fs.openSync(
        path.join(
          installerRoot,
          fs.readdirSync(installerRoot)[0],
          'install.lock'
        ),
        'a'
      );
      const first = spawn('gt', ['log', 'short', '--all'], {
        cwd: fresh,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const done = (child: ReturnType<typeof spawn>) =>
        new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
      const firstDone = done(first);
      let firstOutput = '';
      first.stdout?.on('data', (data) => {
        firstOutput += data;
      });
      first.stderr?.on('data', (data) => {
        firstOutput += data;
      });
      let second: ReturnType<typeof spawn> | undefined;
      try {
        let held = false;
        for (let count = 0; count < 100; count++) {
          try {
            fileLock(fd);
            fileLock(fd, true);
          } catch (error) {
            if (error instanceof FileLockBusyError) {
              held = true;
              break;
            }
            throw error;
          }
          await sleep(25);
        }
        expect(held).to.equal(true);
        second = spawn(
          process.execPath,
          [toggle, 'disable', '--global', '--json'],
          { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        const secondDone = done(second);
        lock.close();
        const firstStatus = await firstDone;
        if (firstStatus !== 0) {
          expect(firstStatus).to.equal(1);
          expect(firstOutput).to.contain('This repository is using Graphite');
        }
        expect(await secondDone).to.equal(0);
        expect(gt(['--version'], 0, root).trim()).to.equal('1.8.6');
        expect(gt(['--version'], 0, fresh).trim()).to.equal('1.8.6');
        expect(fs.readlinkSync(path.join(root, 'bin/gt'))).to.equal(native);
      } finally {
        lock.close();
        fs.closeSync(fd);
        first.kill();
        second?.kill();
      }
    });

    it('can return an unborn repo after the CLI asks for its first commit', () => {
      const fresh = path.join(root, 'unborn');
      fs.mkdirSync(fresh);
      git(['init', '-b', 'main'], undefined, fresh);
      script('enable', ['--global'], 0, root);
      expect(
        gt(['init', '--trunk', 'main', '--no-interactive'], 1, fresh)
      ).to.contain('Please create your first commit');
      script('disable', ['--dry-run'], 0, fresh);
      script('disable', [], 0, fresh);
      expect(
        fs.existsSync(path.join(fresh, '.git/.graphite_metadata.db'))
      ).to.equal(false);
      script('enable', [], 0, fresh);
      expect(gt(['--version'], 0, fresh).trim()).to.equal(version);
      script('disable', [], 0, fresh);
      script('disable', ['--global'], 0, root);
    });

    it('global status and idempotent previews leave selection bytes unchanged', () => {
      script('enable', ['--global'], 0, root);
      const directories = fs.readdirSync(
        path.join(env.XDG_STATE_HOME!, 'gt-gh/launchers')
      );
      const record = path.join(
        env.XDG_STATE_HOME!,
        'gt-gh/launchers',
        directories[0],
        'launcher.json'
      );
      const bytes = fs.readFileSync(record);
      expect(
        JSON.parse(script('enable', ['--global', '--status'], 0, root)).mode
      ).to.equal('gt-gh');
      script('enable', ['--global', '--dry-run'], 0, root);
      script('disable', ['--global', '--dry-run'], 0, root);
      expect(fs.readFileSync(record).equals(bytes)).to.equal(true);
      expect(script('enable', ['--global', '--repo', repo], 1)).to.contain(
        'Do not combine'
      );
      expect(
        script('enable', ['--global', '--restore-missing-parents'], 1)
      ).to.contain('Do not combine');
      script('disable', ['--global'], 0, root);
    });

    it('enables and disables with system sqlite3 blocked on PATH', () => {
      const marker = path.join(root, 'sqlite3-invoked');
      fs.writeFileSync(
        path.join(root, 'bin/sqlite3'),
        `#!/bin/sh\nprintf invoked > '${marker}'\nexit 127\n`,
        { mode: 0o755 }
      );
      script('enable', ['--dry-run']);
      script('enable');
      expect(gt(['info', 'two'])).to.contain('Parent: one');
      script('disable', ['--dry-run']);
      script('disable');
      expect(heads()).to.equal(originalHeads);
      expect(fs.existsSync(marker)).to.equal(false);
    });

    it('previews executable switching without changing the PATH entry or creating an installer record', () => {
      const slot = path.join(root, 'bin/gt'),
        original = fs.readlinkSync(slot);
      const result = JSON.parse(script('enable', ['--dry-run', '--json']));
      expect(result).to.include({ mode: 'gt-gh', dryRun: true });
      expect(fs.readlinkSync(slot)).to.equal(original);
      expect(fs.existsSync(path.join(root, 'state/gt-gh'))).to.equal(false);
      expect(heads()).to.equal(originalHeads);
    });

    it('keeps a failed migration preflight from changing the executable', () => {
      const slot = path.join(root, 'bin/gt'),
        original = fs.readlinkSync(slot),
        refs = git(['show-ref']);
      sqlite(
        db,
        "UPDATE branch_metadata SET parent_branch_name='missing' WHERE branch_name='one';",
        false
      );
      script('enable', [], 1);
      expect(fs.readlinkSync(slot)).to.equal(original);
      expect(git(['show-ref'])).to.equal(refs);
      expect(
        fs.existsSync(path.join(repo, '.git/gt-gh-switch/state.json'))
      ).to.equal(false);
    });

    it('retains a blocking dispatcher across an interrupted enable and cancels safely', () => {
      const slot = path.join(root, 'bin/gt'),
        original = fs.readlinkSync(slot),
        refs = git(['show-ref']);
      const hook = path.join(repo, '.git/hooks/reference-transaction');
      fs.writeFileSync(
        hook,
        '#!/bin/sh\nif [ "$1" = prepared ] && grep -q "refs/branch-metadata/"; then exit 1; fi\nexit 0\n',
        { mode: 0o755 }
      );
      script('enable', [], 1);
      expect(fs.readlinkSync(slot)).not.to.equal(original);
      expect(gt(['log', '--stack'], 1)).to.contain(
        'Backend switch is incomplete'
      );
      fs.unlinkSync(hook);
      script('disable');
      expect(fs.readlinkSync(slot)).to.equal(original);
      expect(heads()).to.equal(originalHeads);
      expect(
        git(['show-ref'])
          .split('\n')
          .filter((line) => !line.includes('refs/gt-switch/'))
          .join('\n')
      ).to.equal(refs);
    });

    it('does not overwrite a replacement gt installed by another writer', () => {
      const slot = path.join(root, 'bin/gt');
      script('enable');
      const current = heads(),
        stateBefore = fs.readFileSync(
          path.join(repo, '.git/gt-gh-switch/state.json')
        );
      const replacement = path.join(root, 'other-gt');
      fs.symlinkSync(native as string, replacement);
      fs.unlinkSync(slot);
      fs.symlinkSync(replacement, slot);
      expect(script('disable', [], 0)).to.contain('changed outside the switch');
      expect(fs.readlinkSync(slot)).to.equal(replacement);
      expect(
        fs
          .readFileSync(path.join(repo, '.git/gt-gh-switch/state.json'))
          .equals(stateBefore)
      ).to.equal(true);
      expect(heads()).to.equal(current);
    });

    it('preserves and restores a regular native binary, not only a Homebrew symlink', () => {
      const slot = path.join(root, 'bin/gt');
      fs.unlinkSync(slot);
      fs.copyFileSync(fs.realpathSync(native as string), slot);
      fs.chmodSync(slot, 0o755);
      const original = fs.readFileSync(slot),
        inode = fs.statSync(slot).ino;
      script('enable');
      expect(fs.lstatSync(slot).isSymbolicLink()).to.equal(true);
      expect(gt(['--version']).trim()).to.equal(version);
      script('disable');
      expect(fs.lstatSync(slot).isFile()).to.equal(true);
      expect(fs.readFileSync(slot).equals(original)).to.equal(true);
      expect(fs.statSync(slot).ino).to.equal(inode);
      expect(gt(['--version']).trim()).to.equal('1.8.6');
    });

    it('uses the same selection from linked worktrees without extension-specific routing', () => {
      const linked = path.join(root, 'linked');
      git(['worktree', 'add', linked, 'one']);
      const slot = path.join(root, 'bin/gt'),
        original = fs.readlinkSync(slot);
      script('enable', [], 0, linked);
      expect(gt(['--version']).trim()).to.equal(version);
      expect(gt(['--version'], 0, linked).trim()).to.equal(version);
      expect(gt(['info', 'one'], 0, linked)).to.contain('one');
      script('disable');
      expect(fs.readlinkSync(slot)).to.equal(original);
      expect(gt(['--version'], 0, linked).trim()).to.equal('1.8.6');
    });

    it('selects per repository and restores the entry only after the last repository disables', () => {
      const slot = path.join(root, 'bin/gt'),
        original = fs.readlinkSync(slot),
        other = path.join(root, 'other');
      git(['clone', '--no-hardlinks', repo, other]);
      for (const branch of ['main', 'one'])
        git(
          ['update-ref', 'refs/heads/' + branch, git(['rev-parse', branch])],
          undefined,
          other
        );
      backupDatabase(db, path.join(other, '.git/.graphite_metadata.db'));
      for (const file of ['.graphite_repo_config', '.graphite_pr_info'])
        fs.copyFileSync(
          path.join(repo, '.git', file),
          path.join(other, '.git', file)
        );
      script('enable');
      expect(gt(['--version']).trim()).to.equal(version);
      expect(gt(['--version'], 0, other).trim()).to.equal('1.8.6');
      script('enable', [], 0, other);
      script('disable');
      expect(fs.readlinkSync(slot)).not.to.equal(original);
      expect(gt(['--version']).trim()).to.equal('1.8.6');
      expect(gt(['--version'], 0, other).trim()).to.equal(version);
      script('disable', [], 0, other);
      expect(fs.readlinkSync(slot)).to.equal(original);
    });

    it('shows dispatcher help and its own version before a repository is enabled', () => {
      const before = git(['show-ref']);
      expect(run(['--version']).trim()).to.equal(version);
      expect(run(['--help'])).to.contain('gt-gh enable');
      expect(run(['-h'])).to.contain('gt-gh disable');
      expect(run(['--repo', repo, 'enable', '--help'])).to.contain(
        'gt-gh enable'
      );
      expect(run(['disable', '--dry-run'])).to.contain(
        'Preview only. Backend selection was not changed.'
      );
      expect(fs.existsSync(path.join(repo, '.git/gt-gh-switch'))).to.equal(
        false
      );
      expect(run(['disable'])).to.contain('Use native gt normally');
      expect(git(['show-ref'])).to.equal(before);
      expect(state().mode).to.equal('graphite');
      expect(
        fs.existsSync(path.join(repo, '.git/gt-gh-switch/state.json'))
      ).to.equal(false);
    });

    it('previews the round trip without writing refs, metadata objects, or a selection', () => {
      const before = git(['show-ref']),
        objects = git(['count-objects', '-v']),
        database = fs.readFileSync(db);
      const result = JSON.parse(
        run([
          '--repo',
          repo,
          '--graphite',
          native as string,
          'enable',
          '--dry-run',
          '--json',
        ])
      );
      expect(result).to.include({ dryRun: true, branches: 2 });
      expect(git(['show-ref'])).to.equal(before);
      expect(git(['count-objects', '-v'])).to.equal(objects);
      expect(fs.readFileSync(db).equals(database)).to.equal(true);
      expect(
        fs.existsSync(path.join(repo, '.git/gt-gh-switch/state.json'))
      ).to.equal(false);
    });

    it('backs up automatically, preserves dirty/index state, and switches back without resetting commits', () => {
      fs.appendFileSync(path.join(repo, 'README'), 'staged\n');
      git(['add', 'README']);
      fs.appendFileSync(path.join(repo, 'README'), 'unstaged\n');
      fs.writeFileSync(
        path.join(repo, 'untracked.bin'),
        Buffer.from([0, 1, 2])
      );
      const index = fs.readFileSync(path.join(repo, '.git/index')),
        status = git(['status', '--porcelain']);
      const database = fs.readFileSync(db);
      const entered = JSON.parse(enable(['--json']));
      expect(
        fs.existsSync(path.join(entered.backup, 'before.sqlite'))
      ).to.equal(true);
      expect(fs.readFileSync(db).equals(database)).to.equal(true);
      expect(meta('one').lastSubmittedVersion).to.deep.equal(
        JSON.parse(originalVersion)
      );
      expect(meta('one').prInfo.number).to.equal(42);
      expect(backend()).to.equal('gt-gh');
      const returned = JSON.parse(run(['disable', '--json']));
      expect(returned.mode).to.equal('graphite');
      expect(
        fs.existsSync(path.join(repo, '.git/gt-gh-switch/state.json'))
      ).to.equal(false);
      expect(heads()).to.equal(originalHeads);
      expect(git(['status', '--porcelain'])).to.equal(status);
      expect(
        fs.readFileSync(path.join(repo, '.git/index')).equals(index)
      ).to.equal(true);
      expect(fs.readFileSync(path.join(repo, 'README'), 'utf8')).to.equal(
        'initial\nstaged\nunstaged\n'
      );
      expect(fs.readFileSync(path.join(repo, 'untracked.bin'))).to.deep.equal(
        Buffer.from([0, 1, 2])
      );
      expect(
        nativeRows(db).find((r) => r.branch_name === 'one')!
          .last_submitted_version
      ).to.equal(originalVersion);
      expect(JSON.parse(run(['--capabilities'])).implementation).to.equal(
        'graphite'
      );
    });

    it('hands back amended, moved, renamed and newly-created branches using current topology', () => {
      enable();
      nodeCommand(['checkout', 'one']);
      fs.appendFileSync(path.join(repo, 'one.txt'), 'amended\n');
      nodeCommand(['modify', '--update', '--message', 'amended one']);
      nodeCommand(['checkout', 'two']);
      nodeCommand(['move', '--onto', 'main']);
      nodeCommand(['rename', 'renamed']);
      fs.writeFileSync(path.join(repo, 'three.txt'), 'three\n');
      nodeCommand(['create', 'three', '--all', '--message', 'three']);
      const current = heads();
      const boundary = meta('renamed').parentBranchRevision;
      run(['disable']);
      expect(heads()).to.equal(current);
      const rows = nativeRows(db);
      expect(rows.find((r) => r.branch_name === 'renamed')).to.include({
        parent_branch_name: 'main',
        parent_branch_revision: boundary,
        validation_result: 'VALID',
      });
      expect(
        rows.find((r) => r.branch_name === 'three')!.parent_branch_name
      ).to.equal('renamed');
      expect(rows.find((r) => r.branch_name === 'two')).to.equal(undefined);
      expect(nodeCommand(['info', 'renamed'])).to.contain('Parent: main');
      expect(nodeCommand(['info', 'three'])).to.contain('Parent: renamed');
    });

    it('preserves the latest published lease and PR identity after GitHub-backed submission', () => {
      enable();
      nodeCommand(['checkout', 'one']);
      fs.appendFileSync(path.join(repo, 'one.txt'), 'published change\n');
      nodeCommand(['modify', '--update', '--message', 'new published version']);
      nodeCommand(['checkout', 'two']);
      nodeCommand(['submit', '--stack', '--no-edit', '--draft']);
      const published = meta('one').prInfo.remoteRevision;
      expect(published).not.to.equal(JSON.parse(originalVersion).headSha);
      const calls = JSON.parse(
        fs.readFileSync(env.GT_FAKE_GITHUB as string, 'utf8')
      ).calls.length;
      const current = heads();
      run(['disable']);
      expect(heads()).to.equal(current);
      const row = nativeRows(db).find((r) => r.branch_name === 'one')!;
      expect(JSON.parse(row.last_submitted_version!).headSha).to.equal(
        published
      );
      const prs = JSON.parse(
        fs.readFileSync(path.join(repo, '.git/.graphite_pr_info'), 'utf8')
      ).prInfos;
      expect(
        prs.find((p: { headRefName: string }) => p.headRefName === 'one')
          .prNumber
      ).to.equal(42);
      expect(
        prs.find((p: { headRefName: string }) => p.headRefName === 'two')
          .prNumber
      ).to.be.a('number');
      expect(
        JSON.parse(fs.readFileSync(env.GT_FAKE_GITHUB as string, 'utf8')).calls
          .length
      ).to.equal(calls);
      expect(nodeCommand(['info', 'one'])).to.contain('PR #42');
    });

    it('preserves optional native version numbers without inventing cloud versions', () => {
      const version = JSON.parse(originalVersion);
      delete version.versionNumber;
      sqlite(
        db,
        `UPDATE branch_metadata SET last_submitted_version='${JSON.stringify(
          version
        )}' WHERE branch_name='one';`,
        false
      );
      enable();
      expect(meta('one').lastSubmittedVersion.versionNumber).to.equal(
        undefined
      );
      nodeCommand(['checkout', 'one']);
      fs.appendFileSync(
        path.join(repo, 'one.txt'),
        'publish without cloud version\n'
      );
      nodeCommand(['modify', '--update', '--message', 'GitHub publication']);
      nodeCommand(['submit', '--stack', '--no-edit', '--draft']);
      const published = meta('one').lastSubmittedVersion;
      expect(published.versionNumber).to.equal(undefined);
      run(['disable']);
      expect(
        JSON.parse(
          nativeRows(db).find((r) => r.branch_name === 'one')!
            .last_submitted_version!
        )
      ).to.deep.equal(published);
    });

    it('keeps the published version on the original branch when splitting it', () => {
      enable();
      nodeCommand(['checkout', 'one']);
      fs.appendFileSync(path.join(repo, 'one.txt'), 'second commit\n');
      nodeCommand(['modify', '--commit', '--update', '--message', 'second']);
      nodeCommand(['split', '--by-commit', '--names', 'lower,one']);
      const current = heads();
      run(['disable']);
      const one = nativeRows(db).find((r) => r.branch_name === 'one')!;
      expect(one.parent_branch_name).to.equal('lower');
      expect(JSON.parse(one.last_submitted_version!).headSha).to.equal(
        JSON.parse(originalVersion).headSha
      );
      expect(heads()).to.equal(current);
    });

    it('does not give a renamed unpublished ref the old branch publication lease', () => {
      enable();
      nodeCommand(['checkout', 'one']);
      nodeCommand(['rename', 'new-name', '--force']);
      expect(meta('new-name').lastSubmittedVersion).to.equal(undefined);
      const current = heads();
      run(['disable']);
      expect(
        nativeRows(db).find((r) => r.branch_name === 'new-name')!
          .last_submitted_version
      ).to.equal(null);
      expect(heads()).to.equal(current);
    });

    it('imports and returns frozen state without clearing protections', () => {
      sqlite(
        db,
        "UPDATE branch_metadata SET state='frozen' WHERE branch_name='one';",
        false
      );
      enable();
      nodeCommand(['checkout', 'one']);
      expect(
        nodeCommand(['modify', '--message', 'must not amend'], 1)
      ).to.contain('frozen');
      run(['disable']);
      expect(
        nativeRows(db).find((r) => r.branch_name === 'one')!.state
      ).to.equal('frozen');
      expect(heads()).to.equal(originalHeads);
    });

    it('can re-enable after native Graphite creates more work', () => {
      enable();
      run(['disable']);
      fs.writeFileSync(path.join(repo, 'native.txt'), 'native work\n');
      nodeCommand([
        'create',
        'native-child',
        '--all',
        '--message',
        'native child',
      ]);
      const current = heads();
      enable();
      expect(heads()).to.equal(current);
      expect(meta('native-child').parentBranchName).to.equal('two');
      expect(meta('one').prInfo.remoteRevision).to.equal(
        JSON.parse(originalVersion).headSha
      );
    });

    for (const operation of ['delete', 'untrack', 'rename']) {
      it(`can re-enable after native Graphite ${operation} removes legacy metadata`, () => {
        enable();
        run(['disable']);
        const archived = state();
        const ref = 'refs/branch-metadata/two';
        expect(archived.metadataRefs[ref]).to.be.a('string');
        nodeCommand(
          operation === 'rename'
            ? ['rename', 'native-renamed', '--force']
            : [operation, 'two', '--force']
        );
        expect(git(['for-each-ref', '--format=%(refname)', ref])).to.equal('');
        expect(
          nativeRows(db).find((row) => row.branch_name === 'two')
            ?.parent_branch_name ?? null
        ).to.equal(null);
        const current = heads();
        fs.appendFileSync(path.join(repo, 'one.txt'), 'staged work\n');
        git(['add', '--', 'one.txt']);
        fs.appendFileSync(path.join(repo, 'one.txt'), 'unstaged work\n');
        fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked work\n');
        const work = git(['diff', 'HEAD']);
        const index = fs.readFileSync(path.join(repo, '.git/index'));
        const database = nativeDigest(db);
        const snapshot = new Repository(repo).snapshot();
        const last = path.join(repo, '.git/gt-gh-switch/last.json');
        const lastBytes = fs.readFileSync(last);
        const objects = git(['count-objects', '-v']);
        enable(['--dry-run']);
        expect(new Repository(repo).snapshot()).to.deep.equal(snapshot);
        expect(fs.readFileSync(last).equals(lastBytes)).to.equal(true);
        expect(git(['count-objects', '-v'])).to.equal(objects);
        enable();
        expect(heads()).to.equal(current);
        expect(nativeDigest(db)).to.equal(database);
        expect(git(['for-each-ref', '--format=%(refname)', ref])).to.equal('');
        if (operation === 'rename')
          expect(meta('native-renamed').parentBranchName).to.equal('one');
        expect(meta('one').lastSubmittedVersion).to.deep.equal(
          JSON.parse(originalVersion)
        );
        run(['disable']);
        expect(heads()).to.equal(current);
        expect(
          nativeRows(db).find((row) => row.branch_name === 'two')
            ?.parent_branch_name ?? null
        ).to.equal(null);
        expect(git(['diff', 'HEAD'])).to.equal(work);
        expect(
          fs.readFileSync(path.join(repo, '.git/index')).equals(index)
        ).to.equal(true);
        expect(
          fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8')
        ).to.equal('untracked work\n');
      });
    }

    for (const operation of ['delete/recreate', 'untrack/retrack']) {
      it(`imports authoritative SQLite after native ${operation} reuses a branch name`, () => {
        enable();
        run(['disable']);
        const ref = 'refs/branch-metadata/two';
        expect(state().metadataRefs[ref]).to.be.a('string');
        if (operation === 'delete/recreate') {
          nodeCommand(['delete', 'two', '--force']);
          nodeCommand(['checkout', 'main']);
          fs.writeFileSync(
            path.join(repo, 'recreated.txt'),
            'new native branch\n'
          );
          nodeCommand(['create', 'two', '--all', '--message', 'recreated two']);
        } else {
          nodeCommand(['untrack', 'two', '--force']);
          nodeCommand(['track', 'two', '--parent', 'main']);
        }
        expect(git(['for-each-ref', '--format=%(refname)', ref])).to.equal('');
        const row = nativeRows(db).find((row) => row.branch_name === 'two')!;
        expect(row.parent_branch_name).to.equal('main');
        const current = heads();
        const database = nativeDigest(db);
        const snapshot = new Repository(repo).snapshot();
        enable(['--dry-run']);
        expect(new Repository(repo).snapshot()).to.deep.equal(snapshot);
        enable();
        expect(heads()).to.equal(current);
        expect(nativeDigest(db)).to.equal(database);
        expect(meta('two').parentBranchName).to.equal('main');
        expect(meta('two').parentBranchRevision).to.equal(
          row.parent_branch_revision
        );
        expect(meta('two').lastSubmittedVersion).to.equal(undefined);
        run(['disable']);
        expect(heads()).to.equal(current);
        expect(
          nativeRows(db).find((row) => row.branch_name === 'two')!
            .parent_branch_name
        ).to.equal('main');
      });
    }

    it('imports and returns native mid-stack untrack without tracking or reparenting its descendants', () => {
      enable();
      for (const branch of ['three', 'four']) {
        fs.writeFileSync(path.join(repo, `${branch}.txt`), `${branch}\n`);
        nodeCommand(['create', branch, '--all', '--message', branch]);
      }
      nodeCommand(['submit', '--stack', '--no-edit', '--draft']);
      nodeCommand(['freeze', 'three']);
      run(['disable']);
      nodeCommand(['untrack', 'two', '--force']);
      expect(
        git(['for-each-ref', '--format=%(refname)', 'refs/branch-metadata/two'])
      ).to.equal('');
      const rows = nativeRows(db);
      expect(rows.find((row) => row.branch_name === 'two')).to.equal(undefined);
      expect(
        rows.find((row) => row.branch_name === 'three')!.parent_branch_name
      ).to.equal('two');
      expect(
        rows.find((row) => row.branch_name === 'four')!.parent_branch_name
      ).to.equal('three');
      fs.appendFileSync(path.join(repo, 'README'), 'staged\n');
      git(['add', '--', 'README']);
      fs.appendFileSync(path.join(repo, 'README'), 'unstaged\n');
      fs.writeFileSync(path.join(repo, 'local.txt'), 'untracked work\n');
      const work = git(['diff', 'HEAD']);
      const staged = git(['diff', '--cached', '--binary']);
      const index = fs.readFileSync(path.join(repo, '.git/index'));
      const current = heads();
      const database = nativeDigest(db);
      const snapshot = new Repository(repo).snapshot();
      enable(['--dry-run']);
      expect(new Repository(repo).snapshot()).to.deep.equal(snapshot);
      enable();
      expect(heads()).to.equal(current);
      expect(nativeDigest(db)).to.equal(database);
      expect(
        fs.readFileSync(path.join(repo, '.git/index')).equals(index),
        'enable preserves index bytes'
      ).to.equal(true);
      for (const branch of ['three', 'four']) {
        const row = rows.find((row) => row.branch_name === branch)!;
        expect(meta(branch).parentBranchName).to.equal(row.parent_branch_name);
        expect(meta(branch).parentBranchRevision).to.equal(
          row.parent_branch_revision
        );
        expect(meta(branch).lastSubmittedVersion).to.deep.equal(
          JSON.parse(row.last_submitted_version!)
        );
      }
      nodeCommand(['log', '--all']);
      expect(
        git(['for-each-ref', '--format=%(refname)', 'refs/branch-metadata/two'])
      ).to.equal('');
      expect(meta('three').parentBranchName).to.equal('two');
      expect(
        nodeCommand(['modify', '--all', '--message', 'must not amend'], 1)
      ).to.contain('track');
      expect(git(['diff', '--cached', '--binary'])).to.equal(staged);
      // CLI commands may refresh Git's index stat cache; handoffs must not.
      const disableIndex = fs.readFileSync(path.join(repo, '.git/index'));
      const enabled = new Repository(repo).snapshot();
      run(['disable', '--dry-run']);
      expect(new Repository(repo).snapshot()).to.deep.equal(enabled);
      run(['disable']);
      expect(heads()).to.equal(current);
      const returned = nativeRows(db);
      expect(
        returned.find((row) => row.branch_name === 'two')?.parent_branch_name ??
          null
      ).to.equal(null);
      for (const branch of ['three', 'four']) {
        const row = returned.find((row) => row.branch_name === branch)!;
        const original = rows.find((row) => row.branch_name === branch)!;
        expect(row.parent_branch_name).to.equal(original.parent_branch_name);
        expect(row.parent_branch_revision).to.equal(
          original.parent_branch_revision
        );
        expect(row.last_submitted_version).to.equal(
          original.last_submitted_version
        );
        expect(row.state).to.equal(original.state);
      }
      const cache = JSON.parse(
        fs.readFileSync(path.join(repo, '.git/.graphite_pr_info'), 'utf8')
      );
      expect(
        cache.prInfos.find((pr: any) => pr.headRefName === 'three').cliTrunk
      ).to.equal('main');
      expect(
        fs.readFileSync(path.join(repo, '.git/index')).equals(disableIndex),
        'disable preserves index bytes'
      ).to.equal(true);
      expect(git(['diff', 'HEAD'])).to.equal(work);
      expect(fs.readFileSync(path.join(repo, 'local.txt'), 'utf8')).to.equal(
        'untracked work\n'
      );
      // A later native track restores the chain without recreating its legacy ref.
      nodeCommand(['track', 'two', '--parent', 'one']);
      enable();
      expect(heads()).to.equal(current);
      expect(meta('two').parentBranchName).to.equal('one');
      expect(meta('three').parentBranchName).to.equal('two');
      expect(meta('four').parentBranchName).to.equal('three');
    });

    it('rebuilds all removed dormant refs solely from verified native SQLite', () => {
      enable();
      run(['disable']);
      const expected = { one: meta('one'), two: meta('two') };
      for (const ref of Object.keys(state().metadataRefs))
        git(['update-ref', '-d', ref]);
      const snapshot = new Repository(repo).snapshot();
      const current = heads();
      const database = nativeDigest(db);
      enable(['--dry-run']);
      expect(new Repository(repo).snapshot()).to.deep.equal(snapshot);
      enable();
      expect(meta('one')).to.deep.equal(expected.one);
      expect(meta('two')).to.deep.equal(expected.two);
      expect(heads()).to.equal(current);
      expect(nativeDigest(db)).to.equal(database);
    });

    for (const operation of ['added', 'changed']) {
      it(`refuses ${operation} metadata from another writer without changing the launcher or either store`, () => {
        script('enable');
        script('disable');
        const ref = `refs/branch-metadata/${
          operation === 'added' ? 'foreign' : 'two'
        }`;
        const blob = git(
          ['hash-object', '-w', '--stdin'],
          JSON.stringify({ parentBranchName: 'main' })
        );
        git(['update-ref', ref, blob]);
        const slot = path.join(root, 'bin/gt');
        const launcher = fs.readlinkSync(slot);
        const snapshot = new Repository(repo).snapshot();
        const database = nativeDigest(db);
        const archived = path.join(repo, '.git/gt-gh-switch/last.json');
        const last = fs.readFileSync(archived);
        const sessions = fs.readdirSync(
          path.join(repo, '.git/gt-gh-switch/sessions')
        );
        for (const args of [['--dry-run'], []]) {
          const output = script('enable', args, 1);
          expect(output).to.contain(`${operation} ${ref}`);
          expect(output).to.contain(`Repository: ${fs.realpathSync(repo)}`);
          expect(output).to.contain('No metadata was overwritten.');
          expect(new Repository(repo).snapshot()).to.deep.equal(snapshot);
          expect(nativeDigest(db)).to.equal(database);
          expect(fs.readlinkSync(slot)).to.equal(launcher);
          expect(fs.readFileSync(archived).equals(last)).to.equal(true);
          expect(
            fs.existsSync(path.join(repo, '.git/gt-gh-switch/state.json'))
          ).to.equal(false);
          expect(
            fs.readdirSync(path.join(repo, '.git/gt-gh-switch/sessions'))
          ).to.deep.equal(sessions);
        }
      });
    }

    it('retains native historical rows that were already absent before the trial', () => {
      sqlite(
        db,
        "INSERT INTO branch_metadata(branch_name,parent_branch_name,state,validation_result) VALUES ('historical-absent','main','frozen','BAD_PARENT_NAME');",
        false
      );
      const historical = nativeRows(db).find(
        (r) => r.branch_name === 'historical-absent'
      );
      enable();
      run(['disable']);
      expect(
        nativeRows(db).find((r) => r.branch_name === 'historical-absent')
      ).to.deep.equal(historical);
      expect(git(['branch', '--list', 'historical-absent'])).to.equal('');
    });

    it('does not resurrect folded, deleted, or deliberately untracked branches', () => {
      enable();
      nodeCommand(['fold']);
      fs.writeFileSync(path.join(repo, 'junk.txt'), 'junk\n');
      nodeCommand(['create', 'junk', '--all', '--message', 'junk']);
      nodeCommand(['delete', 'junk', '--force']);
      fs.writeFileSync(path.join(repo, 'loose.txt'), 'loose\n');
      nodeCommand(['create', 'loose', '--all', '--message', 'loose']);
      nodeCommand(['untrack', 'loose', '--force']);
      const current = heads();
      run(['disable']);
      expect(heads()).to.equal(current);
      const rows = nativeRows(db);
      expect(rows.find((r) => r.branch_name === 'two')).to.equal(undefined);
      expect(rows.find((r) => r.branch_name === 'junk')).to.equal(undefined);
      expect(
        rows.find((r) => r.branch_name === 'loose')?.parent_branch_name ?? null
      ).to.equal(null);
      expect(
        JSON.parse(
          rows.find((r) => r.branch_name === 'one')!.last_submitted_version!
        ).headSha
      ).to.equal(JSON.parse(originalVersion).headSha);
    });

    it('returns reordered dependencies instead of the original SQLite topology', () => {
      enable();
      nodeCommand(['reorder', '--order', 'two,one']);
      const current = heads();
      run(['disable']);
      const rows = nativeRows(db);
      expect(
        rows.find((r) => r.branch_name === 'one')!.parent_branch_name
      ).to.equal('two');
      expect(
        rows.find((r) => r.branch_name === 'two')!.parent_branch_name
      ).to.equal('main');
      expect(heads()).to.equal(current);
    });

    it('preserves multiple trunks in both backends', () => {
      git(['branch', 'release', 'main']);
      const configFile = path.join(repo, '.git/.graphite_repo_config');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config.trunks = [{ name: 'main' }, { name: 'release' }];
      fs.writeFileSync(configFile, JSON.stringify(config));
      enable();
      nodeCommand(['checkout', 'release']);
      fs.writeFileSync(path.join(repo, 'release.txt'), 'release work\n');
      nodeCommand([
        'create',
        'release-child',
        '--all',
        '--message',
        'release child',
      ]);
      const current = heads();
      run(['disable']);
      const rows = nativeRows(db);
      expect(
        rows.find((r) => r.branch_name === 'release')!.validation_result
      ).to.equal('TRUNK');
      expect(
        rows.find((r) => r.branch_name === 'release-child')!.parent_branch_name
      ).to.equal('release');
      expect(heads()).to.equal(current);
      expect(
        JSON.parse(fs.readFileSync(configFile, 'utf8')).trunks.map(
          (t: { name: string }) => t.name
        )
      ).to.deep.equal(['main', 'release']);
    });

    it('restores missing ancestors only with explicit opt-in and retains their leases', () => {
      git(['branch', '-D', 'one']);
      const child = git(['rev-parse', 'two']);
      expect(run(['enable', '--graphite', native as string], 1)).to.contain(
        'Incomplete ancestry'
      );
      enable(['--restore-missing-parents']);
      expect(git(['rev-parse', 'one'])).to.equal(
        JSON.parse(originalVersion).headSha
      );
      run(['disable']);
      expect(git(['rev-parse', 'two'])).to.equal(child);
      expect(
        nativeRows(db).find((r) => r.branch_name === 'one')!
          .last_submitted_version
      ).to.equal(originalVersion);
    });

    it('hands an intentionally unrestacked child back without rewriting its commits', () => {
      enable();
      nodeCommand(['checkout', 'one']);
      fs.appendFileSync(
        path.join(repo, 'one.txt'),
        'unrestacked parent edit\n'
      );
      git(['add', '--', 'one.txt']);
      git(['commit', '--amend', '-m', 'unrestacked']);
      const current = heads();
      const boundary = meta('two').parentBranchRevision;
      run(['disable']);
      expect(heads()).to.equal(current);
      expect(
        nativeRows(db).find((r) => r.branch_name === 'two')!
          .parent_branch_revision
      ).to.equal(boundary);
    });

    it('detects native metadata changes before staging or handing off', () => {
      enable();
      sqlite(
        db,
        "UPDATE branch_metadata SET parent_branch_name='foreign-parent' WHERE branch_name='two';",
        false
      );
      const changed = nativeDigest(db);
      fs.writeFileSync(path.join(repo, 'sentinel'), 'do not stage');
      expect(
        nodeCommand(['create', 'blocked', '--all', '--message', 'blocked'], 1)
      ).to.contain('Graphite metadata changed');
      expect(run(['disable'], 1)).to.contain('Graphite metadata changed');
      expect(nativeDigest(db)).to.equal(changed);
      expect(heads()).to.equal(originalHeads);
      expect(backend()).to.equal('gt-gh');
      expect(git(['diff', '--cached', '--name-only'])).to.equal('');
    });

    it('refuses incomplete published-version data before enabling', () => {
      sqlite(
        db,
        `UPDATE branch_metadata SET last_submitted_version='{"headSha":"${git([
          'rev-parse',
          'one',
        ])}"}' WHERE branch_name='one';`,
        false
      );
      expect(run(['enable', '--graphite', native as string], 1)).to.contain(
        'complete matching published version'
      );
      expect(heads()).to.equal(originalHeads);
      expect(
        git(['for-each-ref', '--format=%(refname)', 'refs/branch-metadata/'])
      ).to.equal('');
    });

    for (const nativeChanged of [false, true]) {
      it(`routing-only re-enable ${
        nativeChanged
          ? 'refuses changed native SQLite'
          : 'preserves native SQLite and pending clone recovery'
      }`, () => {
        script('enable');
        fs.appendFileSync(path.join(repo, 'README'), 'staged\n');
        git(['add', 'README']);
        fs.appendFileSync(path.join(repo, 'README'), 'unstaged\n');
        const id = execFileSync(
          process.execPath,
          [
            '-e',
            `const {beginOperation} = require(${JSON.stringify(
              path.join(path.dirname(cli), 'lib/operations/journal.js')
            )}); console.log(beginOperation('sync', false).id);`,
          ],
          { cwd: repo, env, encoding: 'utf8' }
        ).trim();
        const common = path.join(repo, '.git');
        const journal = path.join(common, 'gt-operations', `${id}.json`);
        expect(JSON.parse(script('disable', ['--json'])).handoff).to.equal(
          'incomplete'
        );
        expect(gt(['--version']).trim()).to.equal('1.8.6');
        if (nativeChanged)
          sqlite(
            db,
            "UPDATE branch_metadata SET state=CASE WHEN state IS NULL THEN 'frozen' ELSE NULL END WHERE branch_name='one';",
            false
          );
        const snapshot = () => ({
          refs: git(['show-ref']),
          metadata: new Repository(repo).snapshot(),
          native: fs.readFileSync(db),
          state: fs.readFileSync(path.join(common, 'gt-gh-switch/state.json')),
          journal: fs.readFileSync(journal),
          pointer: fs.readFileSync(path.join(common, 'gt-operations/latest')),
          index: fs.readFileSync(path.join(common, 'index')),
          working: fs.readFileSync(path.join(repo, 'README')),
        });
        const before = snapshot();
        const result = script('enable', ['--json'], nativeChanged ? 1 : 0);
        if (nativeChanged)
          expect(result).to.contain('Refusing to overwrite newer work');
        else {
          expect(JSON.parse(result)).to.include({
            mode: 'gt-gh',
            selectionOnly: true,
          });
          expect(JSON.parse(result).warnings.join('\n')).to.contain(
            'pending gt operation'
          );
        }
        expect(snapshot()).to.deep.equal(before);
        expect(fs.existsSync(path.join(common, 'gt-cli-native'))).to.equal(
          nativeChanged
        );
        expect(gt(['--version']).trim()).to.equal(
          nativeChanged ? '1.8.6' : version
        );
      });
    }

    it('blocks a pending operation in any linked worktree', () => {
      const worktree = path.join(root, 'linked');
      git(['worktree', 'add', '--detach', worktree, 'main']);
      const dir = git(['rev-parse', '--absolute-git-dir'], undefined, worktree);
      fs.mkdirSync(path.join(dir, 'rebase-merge'));
      expect(run(['enable', '--graphite', native as string], 1)).to.contain(
        'Finish or abort'
      );
      expect(heads()).to.equal(originalHeads);
    });

    it('uses one common selection across linked worktrees and keeps both workspaces', () => {
      const worktree = path.join(root, 'linked');
      git(['worktree', 'add', '--detach', worktree, 'main']);
      fs.writeFileSync(path.join(worktree, 'local.txt'), 'keep linked work');
      run(['enable', '--graphite', native as string], 0, worktree);
      expect(JSON.parse(run(['--capabilities'])).implementation).to.equal(
        'gt-gh'
      );
      run(['disable'], 0, worktree);
      expect(
        fs.readFileSync(path.join(worktree, 'local.txt'), 'utf8')
      ).to.equal('keep linked work');
      expect(heads()).to.equal(originalHeads);
    });

    it('refuses an unknown Graphite binary before changing metadata', () => {
      const fake = path.join(root, 'new-gt');
      fs.writeFileSync(fake, '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });
      expect(run(['enable', '--graphite', fake], 1)).to.contain(
        'verified Graphite 1.8.6'
      );
      expect(heads()).to.equal(originalHeads);
    });

    it('makes repeated enable and disable idempotent', () => {
      enable();
      const first = state().session;
      expect(JSON.parse(enable(['--json'])).already).to.equal(true);
      expect(state().session).to.equal(first);
      run(['disable']);
      const second = state().session;
      expect(JSON.parse(run(['disable', '--json'])).already).to.equal(true);
      expect(state().session).to.equal(second);
    });

    it('cancels an interrupted enable using only its owned changes', async () => {
      const original = Repository.prototype.applyFile;
      Repository.prototype.applyFile = () => {
        throw new Error('simulated crash after ref commit');
      };
      try {
        await switchBackend('enable', options());
        expect.fail('expected interruption');
      } catch (error) {
        expect((error as Error).message).to.contain('simulated crash');
      } finally {
        Repository.prototype.applyFile = original;
      }
      expect(state().mode).to.equal('enabling');
      run(['disable']);
      expect(heads()).to.equal(originalHeads);
      expect(
        git(['for-each-ref', '--format=%(refname)', 'refs/branch-metadata/'])
      ).to.equal('');
      expect(backend()).to.equal('graphite');
    });

    it('resumes disable after the SQLite commit without restoring old work', async () => {
      enable();
      nodeCommand(['checkout', 'two']);
      nodeCommand(['move', '--onto', 'main']);
      const current = heads();
      const original = Repository.prototype.applyFile;
      Repository.prototype.applyFile = () => {
        throw new Error('simulated crash after SQLite commit');
      };
      try {
        await switchBackend('disable', options());
        expect.fail('expected interruption');
      } catch (error) {
        expect((error as Error).message).to.contain('simulated crash');
      } finally {
        Repository.prototype.applyFile = original;
      }
      expect(state().mode).to.equal('disabling');
      expect(nodeCommand(['info', 'two'], 1)).to.contain('Switch interrupted');
      run(['disable']);
      expect(heads()).to.equal(current);
      expect(
        nativeRows(db).find((r) => r.branch_name === 'two')!.parent_branch_name
      ).to.equal('main');
    });

    it('refuses rollback over refs changed after an interrupted enable', async () => {
      const original = Repository.prototype.applyFile;
      Repository.prototype.applyFile = () => {
        throw new Error('simulated crash');
      };
      try {
        await switchBackend('enable', options());
      } catch {
        /* expected */
      } finally {
        Repository.prototype.applyFile = original;
      }
      git(['branch', 'concurrent-work']);
      const current = heads();
      expect(run(['disable'], 1)).to.contain('Git refs changed');
      expect(heads()).to.equal(current);
      expect(state().mode).to.equal('enabling');
    });

    it('waits for the existing common lock without replacing its inode', async () => {
      const directory = path.join(repo, '.git');
      const holder = new StackStore(directory, directory, {
        repositoryLock: true,
      });
      const inode = fs.statSync(path.join(directory, 'gt.lock')).ino;
      const pending = switchBackend('enable', options());
      await sleep(150);
      expect(heads()).to.equal(originalHeads);
      holder.close();
      await pending;
      expect(fs.statSync(path.join(directory, 'gt.lock')).ino).to.equal(inode);
    });

    it('uses a SQLite compare-and-swap instead of overwriting a newer native row', () => {
      const before = path.join(root, 'before.sqlite'),
        target = path.join(root, 'target.sqlite');
      backupDatabase(db, before);
      backupDatabase(db, target);
      sqlite(
        target,
        "UPDATE branch_metadata SET parent_branch_name='main' WHERE branch_name='two';",
        false
      );
      sqlite(
        db,
        "UPDATE branch_metadata SET state='frozen' WHERE branch_name='two';",
        false
      );
      const current = nativeDigest(db);
      expect(() =>
        commitNativeRows(new Repository(repo), before, target)
      ).to.throw();
      expect(nativeDigest(db)).to.equal(current);
    });

    it('guards direct backend entry while Graphite owns the repository', () => {
      enable();
      run(['disable']);
      const result = spawnSync(
        process.execPath,
        [cli, 'create', 'blocked', '--no-interactive', '--message', 'blocked'],
        { cwd: repo, env, encoding: 'utf8' }
      );
      expect(result.status).to.equal(1);
      expect(result.stdout + result.stderr).to.contain(
        'repository is using Graphite'
      );
      expect(heads()).to.equal(originalHeads);
    });
  }
);
