import fs from 'fs';
import path from 'path';
import { atomicJSON, StackStore } from '../github/stack_file';
import {
  Repository,
  RepositoryBusyError,
  RepositoryMissingError,
  equal,
  fail,
} from './repository';
import { fileLock, FileLockBusyError } from '../github/file_lock';
import {
  CandidateBinary,
  SwitchState,
  readState,
  writeState,
  assertNativeUnchanged,
} from './state';
import { assertNoNativeProcess } from './native';
import { BindingLock } from './binding_lock';
import {
  LauncherPlan,
  LauncherRecord,
  launcherFromEnvironment,
  registerRepository,
  removePendingBinding,
  withLauncher,
} from './launcher';
import { registrationSnapshot } from './registration';

/** `missing`: the registered Git directory is absent but automatic cleanup was
 * unsafe. `blocked`: an error needs repair. */
export type BindingFailure = {
  kind: 'busy' | 'blocked' | 'missing';
  reason: string;
};

export function describeBindingFailure(error: unknown): BindingFailure {
  const message =
    error instanceof FileLockBusyError
      ? 'A gt or gh-stack command is still running.'
      : error instanceof Error
      ? error.message
      : String(error);
  return {
    kind:
      error instanceof FileLockBusyError || error instanceof RepositoryBusyError
        ? 'busy'
        : error instanceof RepositoryMissingError
        ? 'missing'
        : 'blocked',
    reason: message.replace(/^ERROR: /, '').trim() || 'Unknown error.',
  };
}

function needsRefresh(
  state: SwitchState | undefined,
  candidate: CandidateBinary
): boolean {
  if (!state)
    return fail(
      'No backend selection is saved for this registered repository.'
    );
  if (state.mode === 'enabling' || state.mode === 'disabling')
    return fail(
      'Backend switch is unfinished. Complete enable/disable before this repository can update.'
    );
  return state.mode === 'gt-gh' && !equal(state.candidate, candidate);
}

/** Probe the permanent BindingLock/StackStore inodes without creating files.
 * A missing inode cannot have a cooperating holder; apply rechecks under real
 * leases. Previews must neither create lock files nor open a writable store. */
function previewLocks(repo: Repository): () => void {
  const descriptors: number[] = [];
  const close = () => descriptors.reverse().forEach((fd) => fs.closeSync(fd));
  try {
    for (const file of [
      path.join(repo.common, 'gt-cli-binding.lock'),
      path.join(repo.common, 'gt.lock'),
      path.join(repo.worktree, 'gh-stack.lock'),
    ]) {
      let fd: number;
      try {
        fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      descriptors.push(fd);
      fileLock(fd);
    }
    return close;
  } catch (error) {
    close();
    throw error;
  }
}

/** Caller holds launcher lock. Never wait on or interrupt repository commands. */
export function refreshBinding(
  repo: Repository,
  candidate: CandidateBinary,
  dryRun = false
): boolean {
  if (!needsRefresh(readState(repo), candidate)) return false;
  const closePreview = dryRun ? previewLocks(repo) : undefined;
  const lease = dryRun ? undefined : new BindingLock(repo.common);
  let store: StackStore | undefined;
  try {
    // StackStore's constructor takes locks non-blockingly. Older dispatchers do
    // not have a binding lease, so the common lock remains necessary too.
    store = dryRun
      ? StackStore.snapshot(repo.worktree, repo.common)
      : new StackStore(repo.worktree, repo.common, { repositoryLock: true });
    const state = readState(repo);
    if (!needsRefresh(state, candidate)) return false;
    repo.assertIdle(); // Includes paused operations in EVERY linked worktree.
    assertNoNativeProcess(repo);
    assertNativeUnchanged(repo, state!);
    fs.accessSync(candidate.node, fs.constants.X_OK);
    fs.accessSync(candidate.script, fs.constants.R_OK);
    if (!dryRun) writeState(repo, { ...state!, candidate });
    return true;
  } finally {
    try {
      store?.close();
    } finally {
      try {
        lease?.close();
      } finally {
        closePreview?.();
      }
    }
  }
}

/** Caller holds the launcher lock. An explicit selection supersedes its old
 * update intent, but must never retarget updates queued for other repositories.
 * Conflicting scoped requests retain the old runtime; the enable warning asks
 * the user to retry when idle. */
export function updateBindingIntent(
  plan: LauncherPlan,
  record: LauncherRecord,
  { common, candidate }: { common: string; candidate?: CandidateBinary }
): LauncherRecord {
  const canonical = fs.realpathSync(common);
  const updated = { ...record };
  removePendingBinding(updated, canonical);
  const pending = updated.pendingBindings;
  if (candidate && (!pending || equal(pending.candidate, candidate)))
    updated.pendingBindings = {
      candidate,
      repositories: [...new Set([...(pending?.repositories ?? []), canonical])],
    };
  atomicJSON(path.join(plan.directory, 'launcher.json'), updated);
  return updated;
}

/**
 * Called before dispatch, never from a running command. Failed/busy refreshes
 * keep both the old selection and durable update intent. A later invocation
 * retries; failure to refresh must not prevent continue/abort using old code.
 * A moved/restored checkout can retain gt-gh state after its old registration
 * was forgotten. Re-enroll it while the dispatcher is active, without changing
 * its backend or losing update/global-handoff coverage.
 */
export async function catchUpBinding(repo: Repository): Promise<void> {
  const initial = launcherFromEnvironment();
  const common = fs.realpathSync(repo.common);
  if (
    !initial ||
    (initial.repositories.includes(common) &&
      !initial.pendingBindings?.repositories.includes(common))
  )
    return;
  try {
    await withLauncher(
      initial.slot,
      async (plan) => {
        let record = plan.record;
        if (!record) return;
        if (
          !record.repositories.includes(common) &&
          readState(repo)?.mode === 'gt-gh'
        ) {
          // Prefer a verified update's durable target, otherwise use the current
          // launcher's own bundle. Re-read under the lock, not from a stale caller.
          const candidate = record.pendingBindings?.candidate ?? {
            node: record.node ?? process.execPath,
            script: path.join(path.dirname(record.dispatcher), 'index.js'),
          };
          record = registerRepository(
            plan,
            record,
            common,
            registrationSnapshot(
              repo,
              record.registrations?.[common]?.source ??
                (record.implementations?.[common]?.mode === 'gt-gh'
                  ? 'explicit'
                  : 'adopted')
            ),
            candidate
          );
        }
        if (!record.pendingBindings?.repositories.includes(common)) return;
        if (record.repositories.includes(common))
          refreshBinding(repo, record.pendingBindings.candidate);
        removePendingBinding(record, common);
        atomicJSON(path.join(plan.directory, 'launcher.json'), record);
      },
      0
    );
  } catch (error) {
    // Contention stays quiet. Other blockers must not silently pin the repo to
    // old code forever, but must still allow commands (especially recovery).
    const failure = describeBindingFailure(error);
    if (failure.kind === 'blocked')
      process.stderr.write(
        `WARNING: gt-cli update is blocked for ${common}.\n${failure.reason}\n` +
          "Keeping this repository's current version. Fix the error above; the next `gt` command will retry automatically.\n"
      );
    // No waiting for an updater or competing command, no version-directory
    // deletion, and no fallback to native Graphite or a guessed candidate.
  }
}
