import koffi from 'koffi';
import { constants } from 'os';
import { ExitFailedError } from '../errors';

// Node has no flock API. Koffi ships ABI-stable prebuilds, avoiding a compiler
// dependency. POSIX flock is required here: fcntl/mkdir locks do NOT coordinate
// with gh-stack's syscall.Flock on Linux.
let flock: ((fd: number, operation: number) => number) | undefined;

// Only contention is retryable; bad descriptors/permissions must fail immediately.
export class FileLockBusyError extends ExitFailedError {
  constructor(errno: number) {
    super(
      `Cannot acquire gh-stack lock (errno ${errno}). Another gt or gh-stack process may be running; retry when it finishes.`
    );
  }
}

export function fileLock(fd: number, release = false, shared = false): void {
  if (process.platform === 'win32') {
    throw new ExitFailedError(
      'The gh-stack metadata bridge currently requires macOS or Linux (flock).'
    );
  }
  if (!flock) {
    flock = koffi.load(null).func('int flock(int fd, int operation)');
  }
  // LOCK_UN=8, LOCK_EX=2, LOCK_SH=1, LOCK_NB=4 on macOS and Linux.
  if (flock(fd, release ? 8 : (shared ? 1 : 2) | 4) !== 0) {
    const errno = koffi.errno();
    if (
      !release &&
      [constants.errno.EAGAIN, constants.errno.EWOULDBLOCK].includes(errno)
    ) {
      throw new FileLockBusyError(errno);
    }
    throw new ExitFailedError(
      `Cannot ${
        release ? 'release' : 'acquire'
      } gh-stack lock (errno ${errno}).`
    );
  }
}
