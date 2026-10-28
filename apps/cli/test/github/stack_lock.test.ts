import { expect } from 'chai';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { fileLock, FileLockBusyError } from '../../src/lib/github/file_lock';
import { StackStore } from '../../src/lib/github/stack_file';

const rejectedOpen = async (
  pending: Promise<StackStore>
): Promise<Error | undefined> =>
  pending.then(
    (store) => {
      store.close();
      return undefined;
    },
    (error: Error) => error
  );

describe('stack lock acquisition', function () {
  this.timeout(10_000);
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-stack-lock-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('queues without blocking the event loop and loads metadata after acquisition', async () => {
    const holder = new StackStore(root, root);
    const inode = fs.statSync(path.join(root, 'gh-stack.lock')).ino;
    const pending = StackStore.open(root, root);
    try {
      // This timer would never run during a blocking flock/Atomics.wait loop.
      await sleep(75);
      holder.file.repository = 'github.com:test/updated';
      holder.save();
    } finally {
      holder.close();
    }
    const next = await pending;
    try {
      expect(next.file.repository).to.equal('github.com:test/updated');
      expect(fs.statSync(path.join(root, 'gh-stack.lock')).ino).to.equal(inode);
    } finally {
      next.close();
    }
  });

  it('waits beyond 30 seconds by default and reports contention once on stderr', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
          const { performance } = require('perf_hooks');
          const { setTimeout: sleep } = require('timers/promises');
          const { StackStore } = require(${JSON.stringify(
            path.resolve(__dirname, '../../src/lib/github/stack_file.js')
          )});
          const directory = process.argv[1];
          (async () => {
            const holder = new StackStore(directory, directory);
            // Advance only this subprocess's monotonic clock, not the test runner's.
            let now = 0;
            Object.defineProperty(performance, 'now', { value: () => now });
            const pending = StackStore.open(directory, directory).then(
              store => ({ store }), error => ({ error })
            );
            try {
              now = 31_000;
              await sleep(75);
              now = 62_000;
              await sleep(75);
              holder.file.repository = 'github.com:test/updated';
              holder.save();
            } finally {
              holder.close();
            }
            const result = await pending;
            if (result.error) throw result.error;
            process.stdout.write(result.store.file.repository);
            result.store.close();
          })().catch(error => {
            process.stderr.write(error.message);
            process.exitCode = 1;
          });
        `,
        root,
      ],
      { encoding: 'utf8', timeout: 5_000 }
    );
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    expect(result.stdout).to.equal('github.com:test/updated');
    const notices = result.stderr.trim().split('\n');
    expect(notices).to.have.length(1);
    expect(notices[0]).to.contain('Waiting for the stack lock');
    expect(notices[0]).to.contain('in this worktree');
    expect(notices[0]).to.contain('Ctrl-C');
  });

  it('bounds contention waits, retains the holder lock, and permits a later retry', async () => {
    const holder = new StackStore(root, root);
    try {
      const error = await rejectedOpen(StackStore.open(root, root, 75));
      expect(error?.message).to.contain('Timed out after 75 ms');
      expect(() => new StackStore(root, root)).to.throw(FileLockBusyError);
    } finally {
      holder.close();
    }
    const retry = await StackStore.open(root, root);
    retry.close();
  });

  it('lets linked worktrees run stack commands concurrently, like native gt', async () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const holder = new StackStore(first, root);
    try {
      const other = await StackStore.open(second, root, 50);
      other.close();
      expect(() => new StackStore(first, root)).to.throw(FileLockBusyError);
      // Stack commands never take the repository-wide lock.
      expect(fs.existsSync(path.join(root, 'gt.lock'))).to.equal(false);
    } finally {
      holder.close();
    }
  });

  it('backend switches and updates still serialize on the repository-wide lock', async () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const holder = new StackStore(first, root, { repositoryLock: true });
    try {
      const error = await rejectedOpen(
        StackStore.open(second, root, 50, { repositoryLock: true })
      );
      expect(error?.message).to.contain('Timed out');
      // No per-worktree lock was acquired before the common lock.
      expect(fs.existsSync(path.join(second, 'gh-stack.lock'))).to.equal(false);
      // A stack command in the other worktree is unaffected.
      const command = new StackStore(second, root);
      command.close();
    } finally {
      holder.close();
    }
    const next = await StackStore.open(second, root, 50, {
      repositoryLock: true,
    });
    next.close();
  });

  it('waits for gh-stack without retaining a partial common lock', async () => {
    const ghFile = path.join(root, 'gh-stack.lock');
    const external = fs.openSync(ghFile, 'a+');
    fileLock(external);
    const inode = fs.statSync(ghFile).ino;
    const pending = StackStore.open(root, root);
    try {
      await sleep(50);
      const common = fs.openSync(path.join(root, 'gt.lock'), 'a+');
      try {
        // Failed attempts must close/unlock all acquired descriptors.
        fileLock(common);
        fileLock(common, true);
      } finally {
        fs.closeSync(common);
      }
    } finally {
      fs.closeSync(external);
    }
    const next = await pending;
    try {
      expect(fs.statSync(ghFile).ino).to.equal(inode);
    } finally {
      next.close();
    }
  });

  it('does not retry malformed metadata or leave acquired locks behind', async () => {
    fs.writeFileSync(path.join(root, 'gh-stack'), '{');
    const error = await rejectedOpen(StackStore.open(root, root, 0));
    expect(error?.message).to.contain('Malformed or unreadable metadata');
    expect(error?.message).not.to.contain('Timed out');
    fs.unlinkSync(path.join(root, 'gh-stack'));
    const next = await StackStore.open(root, root);
    next.close();
  });

  it('does not classify invalid file descriptors as contention', () => {
    let error: Error | undefined;
    try {
      fileLock(-1);
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect(error).not.to.be.instanceOf(FileLockBusyError);
  });
});
