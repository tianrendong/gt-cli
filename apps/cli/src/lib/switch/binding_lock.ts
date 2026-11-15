import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { fileLock, FileLockBusyError } from '../github/file_lock';

/**
 * Dispatchers hold a shared lease through child exit. Rebinding takes an
 * exclusive lease, then the common stack lock. This closes the gap between
 * choosing a candidate and that candidate acquiring its own stack lock, without
 * handing lock descriptors to older releases or blocking nested gt commands.
 * Never unlink this permanent lock inode.
 */
export class BindingLock {
  private fd: number | undefined;

  constructor(common: string, shared = false) {
    const file = path.join(common, 'gt-cli-binding.lock');
    this.fd = fs.openSync(
      file,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600
    );
    try {
      fileLock(this.fd, false, shared);
    } catch (error) {
      fs.closeSync(this.fd);
      this.fd = undefined;
      throw error;
    }
  }

  static async shared(common: string): Promise<BindingLock> {
    return BindingLock.acquire(common, true, 30_000);
  }

  /** Waits for every running stack command in every worktree to finish. */
  static async exclusive(
    common: string,
    timeoutMs: number
  ): Promise<BindingLock> {
    return BindingLock.acquire(common, false, timeoutMs);
  }

  private static async acquire(
    common: string,
    shared: boolean,
    timeoutMs: number
  ): Promise<BindingLock> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return new BindingLock(common, shared);
      } catch (error) {
        if (!(error instanceof FileLockBusyError) || Date.now() >= deadline)
          throw error;
        await sleep(25);
      }
    }
  }

  get descriptor(): number {
    if (this.fd === undefined) throw new Error('Binding lease is closed.');
    return this.fd;
  }

  close(): void {
    if (this.fd !== undefined) {
      // Closing releases only this open-file description's lease.
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }
}
