import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, execFileSync, spawnSync } from 'child_process';
import { promisify } from 'util';
import { setTimeout as sleep } from 'timers/promises';
import { FileLockBusyError } from '../../src/lib/github/file_lock';
import { StackStore } from '../../src/lib/github/stack_file';
import { MUTATIONS } from '../../src/lib/operations/journal';
import { READ_ONLY_COMMANDS } from '../../src/lib/runner';

const cli = path.resolve(__dirname, '../../src/index.js');
const fixture = path.resolve(__dirname, '../../../test/fixtures/fake-gh.cjs');

describe('read-only commands never wait for the stack lock', function () {
  this.timeout(90_000);
  let root: string, repo: string, serverFile: string;
  let env: NodeJS.ProcessEnv;
  const git = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd: repo,
      input,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const spawn = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [cli, ...args, '--no-interactive'], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000,
    });
  const run = (args: string[], status = 0): string => {
    const result = spawn(args);
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(status);
    expect(result.stderr).not.to.contain('Waiting for');
    return result.stdout + result.stderr;
  };
  const create = (name: string): void => {
    fs.writeFileSync(path.join(repo, name + '.txt'), name + '\n');
    run(['create', name, '-am', name]);
  };
  const meta = (branch: string) =>
    JSON.parse(git(['show', 'refs/branch-metadata/' + branch]));
  const refs = () =>
    git([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads/',
      'refs/branch-metadata/',
    ]);
  const gitDir = () => path.join(repo, '.git');
  const cacheFile = () => path.join(gitDir(), '.graphite_cache_persist');
  const metadataFiles = () =>
    ['gh-stack', 'gt-github-sync', '.graphite_cache_persist'].map((name) => {
      const file = path.join(gitDir(), name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    });
  const lockHeld = () =>
    expect(() => new StackStore(gitDir(), gitDir())).to.throw(
      FileLockBusyError
    );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-read-only-'));
    repo = path.join(root, 'repo');
    serverFile = path.join(root, 'github.json');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(repo);
    fs.copyFileSync(fixture, path.join(bin, 'gh'));
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    env = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      GT_FAKE_GITHUB: serverFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user.json'),
    };
    delete env.GRAPHITE_INTERACTIVE;
    delete env.GT_PAGER;
    fs.writeFileSync(
      path.join(root, 'user.json'),
      JSON.stringify({ tips: false })
    );
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    fs.writeFileSync(path.join(repo, 'README'), 'initial\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    fs.writeFileSync(
      path.join(gitDir(), '.graphite_repo_config'),
      JSON.stringify({
        trunk: 'main',
        host: 'github.com',
        owner: 'test',
        name: 'repo',
      })
    );
    fs.writeFileSync(
      serverFile,
      JSON.stringify({ gitDir: repo, next: 1, prs: [], stacks: [], calls: [] })
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists stacks immediately while another command holds the lock, writing nothing', () => {
    create('a');
    create('b');
    const before = { refs: refs(), files: metadataFiles() };
    const holder = new StackStore(gitDir(), gitDir());
    try {
      for (const args of [
        ['log', 'short'],
        ['log', '--stack'],
        ['info'],
        ['parent'],
        ['children'],
        ['trunk'],
        ['github', 'status', '--json'],
      ]) {
        const result = spawn(args);
        expect(result.status, args.join(' ') + result.stderr).to.equal(0);
        expect(result.stderr).not.to.contain('Waiting for');
      }
      expect(run(['log', 'short'])).to.contain('b');
      expect(run(['parent']).trim()).to.equal('a');
      expect(
        JSON.parse(
          spawn(['github', 'status', '--json']).stdout
        ).ghStack.stacks[0].branches.map(
          (branch: { branch: string }) => branch.branch
        )
      ).to.deep.equal(['a', 'b']);
      lockHeld();
    } finally {
      holder.close();
    }
    expect(refs()).to.equal(before.refs);
    expect(metadataFiles()).to.deep.equal(before.files);
  });

  it('mutating commands still queue behind the lock holder', async () => {
    create('a');
    const holder = new StackStore(gitDir(), gitDir());
    const pending = promisify(execFile)(
      process.execPath,
      [cli, 'checkout', 'main', '--no-interactive'],
      { cwd: repo, env, encoding: 'utf8', timeout: 15_000 }
    );
    try {
      await sleep(1_500);
      expect(git(['branch', '--show-current'])).to.equal('a');
    } finally {
      holder.close();
    }
    const result = await pending;
    expect(result.stderr).to.contain('Waiting for the stack lock');
    expect(git(['branch', '--show-current'])).to.equal('main');
  });

  it('shows the unreconciled local view while locked, then imports gh-stack edits once free', () => {
    create('a');
    git(['branch', 'b']);
    const mirrorFile = path.join(gitDir(), 'gh-stack');
    const data = JSON.parse(fs.readFileSync(mirrorFile, 'utf8'));
    data.stacks[0].branches.push({
      branch: 'b',
      base: git(['rev-parse', 'a']),
      head: git(['rev-parse', 'b']),
    });
    const edited = JSON.stringify(data);
    fs.writeFileSync(mirrorFile, edited);
    const holder = new StackStore(gitDir(), gitDir());
    try {
      expect(run(['log', 'short'])).to.contain('a');
      expect(git(['for-each-ref', 'refs/branch-metadata/b'])).to.equal('');
      expect(fs.readFileSync(mirrorFile, 'utf8')).to.equal(edited);
    } finally {
      holder.close();
    }
    expect(run(['log', 'short'])).to.contain('b');
    expect(meta('b').parentBranchName).to.equal('a');
  });

  it('releases the lock before paging so other commands proceed meanwhile', async () => {
    create('a');
    const started = path.join(root, 'paging');
    const release = path.join(root, 'release');
    const pager = path.join(root, 'pager.sh');
    fs.writeFileSync(
      pager,
      `#!/bin/sh\ntouch "${started}"\nwhile [ ! -e "${release}" ]; do sleep 0.05; done\ncat\n`
    );
    fs.chmodSync(pager, 0o755);
    const paging = promisify(execFile)(
      process.execPath,
      // Native only pages with interactive features enabled.
      [cli, 'log', '--interactive'],
      {
        cwd: repo,
        env: { ...env, GT_PAGER: pager },
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    try {
      while (!fs.existsSync(started)) await sleep(20);
      const other = new StackStore(gitDir(), gitDir());
      other.close();
      create('b');
    } finally {
      fs.writeFileSync(release, '');
    }
    const result = await paging;
    expect(result.stdout).to.contain('a (current)');
    expect(git(['branch', '--show-current'])).to.equal('b');
    expect(run(['parent']).trim()).to.equal('a');
  });

  it('persists a lock-free cold parse for exactly the refs it read', () => {
    create('a');
    create('b');
    fs.rmSync(cacheFile(), { force: true });
    const holder = new StackStore(gitDir(), gitDir());
    try {
      expect(run(['log', 'short'])).to.contain('b');
      expect(fs.existsSync(cacheFile())).to.equal(true);
      expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).sha).not.to.equal(
        '0'.repeat(40)
      );
    } finally {
      holder.close();
    }
    expect(run(['parent', '--debug'])).not.to.contain(
      'Building cache from disk'
    );
  });

  it('defers metadata repairs and cache persistence without the lock', () => {
    create('a');
    create('b');
    // Advance a and rebase b onto it outside gt: b's recorded parent revision
    // is stale but still in its history, which a parse repairs.
    run(['checkout', 'a']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'more\n');
    git(['commit', '-am', 'advance a']);
    git(['rebase', 'a', 'b']);
    const stale = meta('b').parentBranchRevision;
    expect(stale).not.to.equal(git(['rev-parse', 'a']));
    fs.rmSync(cacheFile(), { force: true });
    const before = refs();
    const holder = new StackStore(gitDir(), gitDir());
    try {
      const output = run(['log', 'short']);
      expect(output).to.contain('b');
      expect(output).not.to.contain('needs restack');
      expect(refs()).to.equal(before);
      expect(fs.existsSync(cacheFile())).to.equal(false);
    } finally {
      holder.close();
    }
    run(['log', 'short']);
    expect(meta('b').parentBranchRevision).to.equal(git(['rev-parse', 'a']));
    expect(fs.existsSync(cacheFile())).to.equal(true);
  });

  for (const [kind, error] of [
    ['invalid pointer', 'Invalid operation journal'],
    ['malformed journal', 'Malformed or unreadable metadata'],
    ['incompatible journal', 'written by an incompatible gt version'],
  ]) {
    it(`allows inspection, but not undo, with ${kind}`, () => {
      create('a');
      const latest = path.join(gitDir(), 'gt-operations/latest');
      const id = JSON.parse(fs.readFileSync(latest, 'utf8'));
      const operation = path.join(gitDir(), 'gt-operations', `${id}.json`);
      if (kind === 'invalid pointer') {
        fs.writeFileSync(latest, JSON.stringify('invalid'));
      } else if (kind === 'malformed journal') {
        fs.writeFileSync(operation, '{');
      } else {
        const data = JSON.parse(fs.readFileSync(operation, 'utf8'));
        fs.writeFileSync(operation, JSON.stringify({ ...data, version: 2 }));
      }
      const snapshot = () => ({
        refs: refs(),
        files: metadataFiles().slice(0, 2),
        journal: [latest, operation].map((file) =>
          fs.readFileSync(file, 'utf8')
        ),
      });
      const before = snapshot();
      for (const args of [
        ['info', 'a'],
        ['log', '--stack'],
        ['state'],
        ['github', 'status', '--json'],
      ]) {
        run(args);
        expect(snapshot(), args.join(' ')).to.deep.equal(before);
      }
      expect(run(['undo', '--force'], 1)).to.contain(error);
      expect(snapshot()).to.deep.equal(before);
    });
  }

  it('does not rewrite a relocated repository journal during inspection', () => {
    create('a');
    const moved = path.join(root, 'moved');
    fs.renameSync(repo, moved);
    repo = moved;
    const id = JSON.parse(
      fs.readFileSync(path.join(gitDir(), 'gt-operations/latest'), 'utf8')
    );
    const operation = path.join(gitDir(), 'gt-operations', `${id}.json`);
    const before = fs.readFileSync(operation, 'utf8');

    run(['info', 'a']);
    run(['log', '--stack']);

    expect(fs.readFileSync(operation, 'utf8')).to.equal(before);
    run(['undo', '--force']);
    expect(git(['branch', '--show-current'])).to.equal('main');
  });

  for (const recovery of ['abort', 'continue']) {
    it(`keeps pending move checkpoints unchanged through inspection and ${recovery}`, () => {
      fs.writeFileSync(path.join(repo, 'second.txt'), 'base second\n');
      git(['add', '--', 'second.txt']);
      git(['commit', '-m', 'second conflict base']);
      create('old-parent');
      fs.writeFileSync(path.join(repo, 'README'), 'branch first\n');
      run(['create', 'a', '-am', 'first branch']);
      fs.writeFileSync(path.join(repo, 'second.txt'), 'branch second\n');
      run(['create', 'b', '-am', 'second branch']);
      run(['checkout', 'main']);
      fs.writeFileSync(path.join(repo, 'README'), 'trunk first\n');
      fs.writeFileSync(path.join(repo, 'second.txt'), 'trunk second\n');
      git(['commit', '-am', 'advance trunk with conflicts']);
      run(['checkout', 'b']);
      const original = refs();
      const inspect = () => {
        const before = { refs: refs(), files: metadataFiles().slice(0, 2) };
        for (const args of [
          ['info', 'a'],
          ['branch', 'info'],
          ['log', '--stack'],
          ['github', 'status', '--json'],
        ]) {
          run(args);
          expect(refs(), args.join(' ')).to.equal(before.refs);
          expect(metadataFiles().slice(0, 2), args.join(' ')).to.deep.equal(
            before.files
          );
        }
      };

      expect(run(['move', '--source', 'a', '--onto', 'main'], 1)).to.contain(
        'Hit conflict restacking a'
      );
      inspect();
      fs.writeFileSync(path.join(repo, 'README'), 'resolved first\n');
      git(['add', '--', 'README']);
      expect(run(['continue'], 1)).to.contain('Hit conflict restacking b');
      inspect();
      if (recovery === 'abort') {
        run(['abort', '--force']);
        expect(refs()).to.equal(original);
        expect(meta('a').parentBranchName).to.equal('old-parent');
      } else {
        fs.writeFileSync(path.join(repo, 'second.txt'), 'resolved second\n');
        git(['add', '--', 'second.txt']);
        run(['continue']);
        expect(meta('a').parentBranchName).to.equal('main');
        expect(meta('b').parentBranchRevision).to.equal(
          git(['rev-parse', 'a'])
        );
      }
      expect(git(['branch', '--show-current'])).to.equal(
        recovery === 'abort' ? 'b' : 'a'
      );
      expect(git(['status', '--porcelain'])).to.equal('');
      expect(fs.existsSync(path.join(gitDir(), '.gtcontinue'))).to.equal(false);
    });
  }

  it('does not hide genuine metadata drift during pending recovery', () => {
    fs.writeFileSync(path.join(repo, 'README'), 'branch change\n');
    run(['create', 'a', '-am', 'branch change']);
    run(['checkout', 'main']);
    fs.writeFileSync(path.join(repo, 'README'), 'trunk change\n');
    git(['commit', '-am', 'trunk change']);
    run(['checkout', 'a']);
    run(['restack'], 1);
    const file = path.join(gitDir(), '.gtcontinue');
    const external = JSON.stringify({
      ...JSON.parse(fs.readFileSync(file, 'utf8')),
      externallyEdited: true,
    });
    fs.writeFileSync(file, external);
    const before = refs();

    run(['info', 'a']);

    expect(fs.readFileSync(file, 'utf8')).to.equal(external);
    expect(run(['abort', '--force'], 1)).to.contain(
      'Stack metadata changed outside this operation'
    );
    expect(refs()).to.equal(before);
    expect(fs.readFileSync(file, 'utf8')).to.equal(external);
    expect(fs.existsSync(path.join(gitDir(), 'rebase-merge'))).to.equal(true);
  });

  it('never classifies a journaled mutation as read-only', () => {
    for (const command of READ_ONLY_COMMANDS) {
      expect(MUTATIONS.has(command), command).to.equal(false);
    }
    const sources: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.js'))
          sources.push(fs.readFileSync(file, 'utf8'));
      }
    };
    walk(path.resolve(__dirname, '../../src/commands'));
    for (const command of READ_ONLY_COMMANDS) {
      expect(
        sources.some((source) => source.includes(`'${command}'`)),
        `${command} is not a canonical command name`
      ).to.equal(true);
    }
  });
});
