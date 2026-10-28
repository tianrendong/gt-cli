import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, spawnSync, ChildProcess } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { Repository } from '../../src/lib/switch/repository';
import {
  ABSENT_NATIVE_DIGEST,
  CandidateBinary,
  readState,
  writeState,
} from '../../src/lib/switch/state';
import {
  withLauncher,
  setGlobalMode,
  planLauncher,
  registerRepository,
} from '../../src/lib/switch/launcher';
import { upgradeBindings } from '../../src/lib/switch/upgrade';
import { BindingLock } from '../../src/lib/switch/binding_lock';

const dist = path.resolve(__dirname, '../../src');
const dispatcher = path.join(dist, 'gt_cli.js');

describe('automatic deferred binding updates', function () {
  this.timeout(30_000);
  let root: string,
    repo: string,
    slot: string,
    old: CandidateBinary,
    latest: CandidateBinary;
  let savedEnv: NodeJS.ProcessEnv;
  let children: {
    process: ChildProcess;
    closed: Promise<void>;
    release: string;
    output: () => string;
  }[];
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const common = (cwd = repo): string =>
    fs.realpathSync(
      git(cwd, 'rev-parse', '--git-common-dir').startsWith('/')
        ? git(cwd, 'rev-parse', '--git-common-dir')
        : path.resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir'))
    );
  const invoke = (args: string[], cwd = repo) =>
    spawnSync(slot, args, { cwd, encoding: 'utf8', timeout: 10_000 });
  const run = (args: string[], cwd = repo): string => {
    const result = invoke(args, cwd);
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    return result.stdout.trim();
  };
  const state = (cwd = repo) => readState(new Repository(cwd))!;
  const pending = () => planLauncher(slot).record?.pendingBindings;
  const upgrade = (candidate = latest) =>
    upgradeBindings({
      slot,
      candidate,
      dispatcher,
      beforeChange: () => {},
      finish: () => {},
    });
  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw Error('Timed out waiting for fixture process');
      await sleep(20);
    }
  }
  function probe(label: string): CandidateBinary {
    const script = path.join(root, label + '.cjs');
    fs.writeFileSync(
      script,
      `const fs=require('fs'),path=require('path'),cp=require('child_process');
const args=process.argv.slice(2);
if(args[0]==='continue'||args[0]==='abort'||args[0]==='undo') {
 const dir=cp.execFileSync('git',['rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim();
 fs.rmSync(path.join(dir,'.gtcontinue'),{force:true});
 const file=path.join(dir,'gt-operations/1-abc.json');
 if(fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({version:1,pending:false}));
}
console.log(${JSON.stringify(label)});
if(args[0]==='hold') {
 fs.writeFileSync(args[1],String(process.pid));
 const deadline=Date.now()+20000;
 const timer=setInterval(()=>{if(fs.existsSync(args[2])||Date.now()>deadline)clearInterval(timer)},20);
}
`
    );
    return { node: process.execPath, script };
  }
  async function repository(name: string): Promise<string> {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    git(cwd, 'init', '-b', 'main');
    fs.writeFileSync(path.join(cwd, 'README'), 'original\n');
    git(cwd, 'add', 'README');
    git(
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'initial'
    );
    const local = new Repository(cwd);
    await withLauncher(slot, async (plan) => {
      writeState(local, {
        schemaVersion: 1,
        mode: 'gt-gh',
        session: '1-0123456789ab',
        candidate: old,
        native: plan.native,
        nativeAbsent: true,
        nativeDigest: ABSENT_NATIVE_DIGEST,
        prCache: null,
        repoConfig: null,
      });
      registerRepository(plan, plan.record!, common(cwd));
    });
    return cwd;
  }
  async function hold(cwd = repo) {
    const ready = path.join(root, 'ready-' + children.length);
    const release = path.join(root, 'release-' + children.length);
    const child = spawn(slot, ['hold', ready, release], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout!.on('data', (data) => {
      output += data.toString();
    });
    child.stderr!.on('data', (data) => {
      output += data.toString();
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    const running = { process: child, closed, release, output: () => output };
    children.push(running);
    await waitFor(() => fs.existsSync(ready));
    return running;
  }
  const finish = async (running: Awaited<ReturnType<typeof hold>>) => {
    fs.writeFileSync(running.release, 'finish');
    await running.closed;
  };

  beforeEach(async () => {
    savedEnv = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-binding-update-'))
    );
    fs.mkdirSync(path.join(root, 'bin'));
    fs.mkdirSync(path.join(root, 'home'));
    const native = path.join(root, 'native');
    fs.writeFileSync(native, '#!/bin/sh\nprintf "1.8.6\\n"\n', { mode: 0o755 });
    slot = path.join(root, 'bin/gt');
    fs.symlinkSync(native, slot);
    Object.assign(process.env, {
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      PATH:
        path.join(root, 'bin') +
        path.delimiter +
        path.dirname(process.execPath) +
        path.delimiter +
        savedEnv.PATH,
    });
    for (const key of [
      'GT_GH_LAUNCHER_RECORD',
      'GIT_DIR',
      'GIT_COMMON_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
    ])
      delete process.env[key];
    children = [];
    old = probe('old');
    latest = probe('new');
    await withLauncher(slot, async (plan) => {
      setGlobalMode(plan, dispatcher, true);
    });
    repo = await repository('repo');
  });
  afterEach(async () => {
    try {
      for (const running of children)
        fs.writeFileSync(running.release, 'finish');
      await Promise.all(children.map((running) => running.closed));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });

  it('leaves running code alone and uses latest on the next command without another update', async () => {
    const other = await repository('other');
    const index = fs.readFileSync(path.join(common(), 'index'));
    const head = git(repo, 'rev-parse', 'HEAD');
    const running = await hold(); // No stack lock yet: the dispatch lease protects startup too.
    const result = await upgrade();
    expect(result.deferred.map((d) => d.repository)).to.deep.equal([common()]);
    expect(result.deferred[0].kind).to.equal('busy');
    expect(state().candidate).to.deep.equal(old);
    expect(run(['--version'], other)).to.equal('new');
    const concurrent = invoke(['--version']);
    expect(concurrent.status).to.equal(0);
    expect(concurrent.stdout.trim()).to.equal('old'); // Shared old binding.
    expect(concurrent.stderr).to.equal(''); // Normal contention stays quiet.
    await finish(running);
    expect(running.output()).to.equal('old\n');
    expect(run(['--version'])).to.equal('new'); // No gt-cli update between these calls.
    expect(state().candidate).to.deep.equal(latest);
    expect(pending()).to.equal(undefined);
    expect(
      fs.readFileSync(path.join(common(), 'index')).equals(index)
    ).to.equal(true);
    expect(git(repo, 'rev-parse', 'HEAD')).to.equal(head);
  });

  for (const command of ['continue', 'abort']) {
    it(`keeps paused linked-worktree operations on old code through ${command}`, async () => {
      const linked = path.join(root, 'linked');
      git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
      const dir = git(linked, 'rev-parse', '--absolute-git-dir');
      fs.writeFileSync(path.join(dir, '.gtcontinue'), '{}');
      fs.mkdirSync(path.join(dir, 'gt-operations'));
      fs.writeFileSync(path.join(dir, 'gt-operations/latest'), '"1-abc"');
      fs.writeFileSync(
        path.join(dir, 'gt-operations/1-abc.json'),
        '{"pending":true}'
      );
      const result = await upgrade();
      expect(result.deferred).to.have.length(1);
      expect(run(['--version'])).to.equal('old');
      expect(
        fs.readFileSync(path.join(dir, 'gt-operations/1-abc.json'), 'utf8')
      ).to.equal('{"pending":true}');
      expect(run([command], linked)).to.equal('old');
      expect(run(['--version'])).to.equal('new');
      expect(run(['--version'], linked)).to.equal('new');
      expect(pending()).to.equal(undefined);
    });
  }

  for (const field of ['restoringRefs', 'abortingRebase']) {
    it(`keeps an interrupted rollback on old code (${field})`, async () => {
      const linked = path.join(root, 'linked');
      git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
      const dir = git(linked, 'rev-parse', '--absolute-git-dir');
      fs.mkdirSync(path.join(dir, 'gt-operations'));
      fs.writeFileSync(path.join(dir, 'gt-operations/latest'), '"1-abc"');
      const content = JSON.stringify({
        pending: false,
        [field]: field === 'restoringRefs' ? {} : true,
      });
      fs.writeFileSync(path.join(dir, 'gt-operations/1-abc.json'), content);
      const result = await upgrade();
      expect(result.deferred).to.have.length(1);
      expect(result.deferred[0].kind).to.equal('busy');
      expect(run(['--version'])).to.equal('old');
      expect(
        fs.readFileSync(path.join(dir, 'gt-operations/1-abc.json'), 'utf8')
      ).to.equal(content);
      expect(run(['undo'], linked)).to.equal('old');
      expect(run(['--version'])).to.equal('new');
      expect(pending()).to.equal(undefined);
    });
  }

  for (const fixture of [
    { name: 'deleted linked', removed: true, locked: false },
    { name: 'offline linked', removed: true, locked: true },
    {
      name: 'linked with "quotes"\tand\nnewline',
      removed: false,
      locked: false,
    },
    {
      name: 'deleted with "quotes"\tand\nnewline',
      removed: true,
      locked: false,
    },
  ]) {
    it(`updates without pruning worktree metadata (${JSON.stringify(
      fixture
    )})`, async () => {
      const linked = path.join(root, fixture.name);
      git(repo, 'worktree', 'add', '-b', 'linked', linked, 'HEAD');
      const dir = git(linked, 'rev-parse', '--absolute-git-dir');
      if (fixture.locked) git(repo, 'worktree', 'lock', linked);
      if (fixture.removed) fs.rmSync(linked, { recursive: true });
      const local = new Repository(repo);
      const before = local.snapshot();
      const index = fs.readFileSync(path.join(local.worktree, 'index'));
      const metadata = () =>
        Object.fromEntries(
          fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => [
              entry.name,
              fs.readFileSync(path.join(dir, entry.name)),
            ])
        );
      const retained = metadata();

      const result = await upgrade();
      expect(result.deferred).to.deep.equal([]);
      expect(result.repositories).to.deep.equal([repo]);
      expect(run(['--version'])).to.equal('new');
      expect(state().candidate).to.deep.equal(latest);
      expect(pending()).to.equal(undefined);
      expect(local.snapshot()).to.deep.equal(before);
      expect(fs.readFileSync(path.join(local.worktree, 'index'))).to.deep.equal(
        index
      );
      expect(metadata()).to.deep.equal(retained);
      expect(
        planLauncher(slot).record?.registrations?.[common()].worktrees
      ).to.include(linked);
    });
  }

  it('catches up after a linked checkout is deleted during a running command', async () => {
    const linked = path.join(root, 'deleted-linked');
    git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
    const running = await hold();
    expect((await upgrade()).deferred).to.have.length(1);
    fs.rmSync(linked, { recursive: true });
    const before = new Repository(repo).snapshot();
    await finish(running);

    expect(run(['--version'])).to.equal('new');
    expect(pending()).to.equal(undefined);
    expect(new Repository(repo).snapshot()).to.deep.equal(before);
  });

  for (const marker of [
    '.gtcontinue',
    'rebase-merge',
    'gt-operations/latest',
  ]) {
    it(`preserves paused ${marker} metadata even when its checkout is missing`, async () => {
      const linked = path.join(root, 'missing-paused');
      git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
      const dir = git(linked, 'rev-parse', '--absolute-git-dir');
      const file = path.join(dir, marker);
      if (marker === 'rebase-merge') fs.mkdirSync(file);
      else if (marker === 'gt-operations/latest') {
        fs.mkdirSync(path.dirname(file));
        fs.writeFileSync(file, '"1-abc"');
        fs.writeFileSync(
          path.join(dir, 'gt-operations/1-abc.json'),
          '{"pending":true}'
        );
      } else fs.writeFileSync(file, '{}');
      fs.rmSync(linked, { recursive: true });
      const before = new Repository(repo).snapshot();

      const result = await upgrade();
      expect(result.deferred).to.have.length(1);
      expect(result.deferred[0].kind).to.equal('busy');
      expect(result.deferred[0].reason).to.contain('Finish or abort');
      expect(result.deferred[0].reason).to.contain(dir);
      expect(state().candidate).to.deep.equal(old);
      expect(run(['--version'])).to.equal('old');
      expect(fs.existsSync(file)).to.equal(true);
      expect(pending()?.repositories).to.include(common());
      expect(new Repository(repo).snapshot()).to.deep.equal(before);
    });
  }

  for (const target of ['worktrees', 'linked']) {
    it(`does not mistake unreadable ${target} metadata for an idle worktree`, async function () {
      if (process.getuid?.() === 0) this.skip();
      const linked = path.join(root, 'unreadable-linked');
      git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
      const dir = git(linked, 'rev-parse', '--absolute-git-dir');
      fs.writeFileSync(path.join(dir, '.gtcontinue'), '{}');
      const unreadable = target === 'worktrees' ? path.dirname(dir) : dir;
      fs.chmodSync(unreadable, 0o000);
      try {
        const result = await upgrade();
        expect(result.deferred).to.have.length(1);
        expect(result.deferred[0].kind).to.equal('blocked');
        expect(result.deferred[0].reason).to.contain('EACCES');
        expect(state().candidate).to.deep.equal(old);
        expect(pending()?.repositories).to.include(common());
      } finally {
        fs.chmodSync(unreadable, 0o700);
      }
      expect(fs.readFileSync(path.join(dir, '.gtcontinue'), 'utf8')).to.equal(
        '{}'
      );
    });
  }

  for (const target of ['worktrees', 'linked']) {
    it(`blocks symlinked ${target} metadata instead of skipping safety checks`, async () => {
      const linked = path.join(root, 'linked');
      git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
      const dir = git(linked, 'rev-parse', '--absolute-git-dir');
      const replaced = target === 'worktrees' ? path.dirname(dir) : dir;
      const backup = path.join(root, 'original-metadata');
      fs.renameSync(replaced, backup);
      fs.symlinkSync(backup, replaced);

      const result = await upgrade();
      expect(result.deferred).to.have.length(1);
      expect(result.deferred[0].kind).to.equal('blocked');
      expect(result.deferred[0].reason).to.contain(
        'Refusing symlinked worktree metadata'
      );
      expect(state().candidate).to.deep.equal(old);
      expect(pending()?.repositories).to.include(common());
      expect(fs.readlinkSync(replaced)).to.equal(backup);
    });
  }

  it('reports malformed retained operation metadata as blocked rather than busy', async () => {
    const linked = path.join(root, 'missing-invalid');
    git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
    const dir = git(linked, 'rev-parse', '--absolute-git-dir');
    fs.mkdirSync(path.join(dir, 'gt-operations'));
    fs.writeFileSync(path.join(dir, 'gt-operations/latest'), '"../invalid"');
    fs.rmSync(linked, { recursive: true });

    const result = await upgrade();
    expect(result.deferred[0].kind).to.equal('blocked');
    expect(result.deferred[0].reason).to.contain(
      'Invalid operation journal pointer'
    );
    const command = invoke(['--version']);
    expect(command.status).to.equal(0);
    expect(command.stdout.trim()).to.equal('old');
    expect(command.stderr).to.contain('WARNING: gt-cli update is blocked');
    expect(command.stderr).to.contain('Invalid operation journal pointer');
    expect(pending()?.repositories).to.include(common());
  });

  it('runs this release in one process while retaining its lease through async handlers', async () => {
    const config = JSON.stringify({
      trunk: 'main',
      isGithubIntegrationEnabled: false,
    });
    fs.writeFileSync(path.join(repo, '.git/.graphite_repo_config'), config);
    const current = {
      node: process.execPath,
      script: path.join(dist, 'index.js'),
    };
    writeState(new Repository(repo), {
      ...state(),
      candidate: current,
      repoConfig: Buffer.from(config).toString('base64'),
    });
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(repo, 'work'), 'staged work\n');
    git(repo, 'add', 'work');
    const ready = path.join(root, 'core-ready');
    const release = path.join(root, 'core-release');
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(
      path.join(hooks, 'pre-commit'),
      `#!/bin/sh\nprintf ready > '${ready}'\nwhile [ ! -e '${release}' ]; do sleep 0.02; done\n`,
      { mode: 0o755 }
    );
    git(repo, 'config', 'core.hooksPath', hooks);
    const starts = path.join(root, 'node-starts');
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(
      preload,
      `require('fs').appendFileSync(${JSON.stringify(
        starts
      )}, process.pid+'\\n');`
    );
    const child = spawn(
      slot,
      ['--no-interactive', 'create', 'new-branch', '-m', 'new work'],
      {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
      }
    );
    let output = '';
    child.stdout!.on('data', (data) => (output += data.toString()));
    child.stderr!.on('data', (data) => (output += data.toString()));
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(Error(output))
      );
      child.once('error', reject);
    });
    const running = { process: child, closed, release, output: () => output };
    children.push(running);
    await waitFor(() => fs.existsSync(ready));
    expect(() => {
      const lease = new BindingLock(common());
      lease.close();
    }).to.throw('Cannot acquire gh-stack lock');
    expect((await upgrade()).deferred).to.have.length(1);
    expect(state().candidate).to.deep.equal(current);
    await finish(running);
    expect(fs.readFileSync(starts, 'utf8').trim().split('\n')).to.have.length(
      1
    );
    expect(git(repo, 'branch', '--show-current')).to.equal('new-branch');
    expect(run(['--version'])).to.equal('new');
  });

  it('uses the newest requested release after several updates during one command', async () => {
    const running = await hold();
    await upgrade();
    const newest = probe('newest');
    await upgrade(newest);
    expect(state().candidate).to.deep.equal(old);
    expect(pending()?.candidate).to.deep.equal(newest);
    await finish(running);
    expect(run(['--version'])).to.equal('newest');
    expect(pending()).to.equal(undefined);
  });

  it('does not block old commands when another installer owns the launcher lock', async () => {
    const running = await hold();
    await upgrade();
    await finish(running);
    await withLauncher(slot, async () => {
      expect(run(['--version'])).to.equal('old');
    });
    expect(run(['--version'])).to.equal('new');
  });

  it('retains intent and the working old binding if the target disappears', async () => {
    const running = await hold();
    await upgrade();
    await finish(running);
    const bytes = fs.readFileSync(latest.script);
    fs.unlinkSync(latest.script);
    const command = invoke(['--version']);
    expect(command.status).to.equal(0);
    expect(command.stdout.trim()).to.equal('old');
    expect(command.stderr).to.contain('WARNING: gt-cli update is blocked');
    expect(command.stderr).to.contain(latest.script);
    expect(command.stderr).to.contain(
      "Keeping this repository's current version"
    );
    expect(command.stderr).to.contain('Fix the error above');
    expect(state().candidate).to.deep.equal(old);
    expect(pending()?.repositories).to.include(common());
    fs.writeFileSync(latest.script, bytes);
    expect(run(['--version'])).to.equal('new');
  });

  it('clears pending intent when the user explicitly opts out to native Graphite', async () => {
    const running = await hold();
    await upgrade();
    await finish(running);
    const result = spawnSync(
      process.execPath,
      [
        path.join(dist, 'toggle_cli.js'),
        'disable',
        '--repo',
        repo,
        '--no-interactive',
      ],
      {
        encoding: 'utf8',
        cwd: repo,
      }
    );
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    expect(pending()).to.equal(undefined);
    expect(run(['--version'])).to.equal('1.8.6');
    expect(state().mode).to.equal('graphite');
  });

  it('retains the shared lease in an orphaned child if its dispatcher is killed', async () => {
    const running = await hold();
    const exited = new Promise<void>((resolve) =>
      running.process.once('exit', () => resolve())
    );
    running.process.kill('SIGKILL');
    await exited;
    const result = await upgrade();
    expect(result.deferred).to.have.length(1);
    expect(state().candidate).to.deep.equal(old);
    await finish(running);
    expect(run(['--version'])).to.equal('new');
  });
});
