import fs from 'fs';
import { Repository, equal, fail } from './repository';
import { assertNativeUnchanged, readState, sessionDirectory } from './state';
import { assertNoNativeProcess } from './native';
import { describeBindingFailure, refreshBinding } from './binding_update';
import type { SwitchOptions, SwitchResult } from './transition';

/** No metadata handoff is needed when the clone still owns this repository.
 * Restoring its routing must not require finishing the operation that needs
 * that very runtime to continue/abort. Never discard or reinterpret a journal. */
export function resumeExistingClone(
  repo: Repository,
  options: Pick<SwitchOptions, 'candidate' | 'dryRun'>
): SwitchResult {
  const current = () => {
    repo.assertSwitchContext();
    const state = readState(repo);
    if (state?.mode !== 'gt-gh')
      return fail(
        'Backend ownership changed during enable. Retry; nothing was reset.'
      );
    assertNoNativeProcess(repo);
    assertNativeUnchanged(repo, state);
    return state;
  };
  const before = current();
  let reason: string | undefined;
  let blocked = false;
  try {
    // Check even when the candidate is unchanged, so paused/damaged recovery
    // state is reported rather than silently claiming the repository is idle.
    repo.assertIdle();
    refreshBinding(repo, options.candidate, options.dryRun);
  } catch (error) {
    const failure = describeBindingFailure(error);
    reason = failure.reason;
    blocked = failure.kind !== 'busy';
  }
  // A failed refresh is deferrable only while the existing owner and native
  // baseline remain valid. In particular, never turn native drift into success.
  const after = current();
  if (reason && !equal(before, after))
    return fail(
      'Backend state changed during enable. Retry; nothing was reset.'
    );
  const candidate =
    options.dryRun && !reason ? options.candidate : after.candidate;
  try {
    fs.accessSync(candidate.node, fs.constants.X_OK);
    fs.accessSync(candidate.script, fs.constants.R_OK);
  } catch (error) {
    return fail(
      `The saved clone runtime is unavailable: ${error.message}\n` +
        'Restore that runtime before resuming this operation. Recovery data and native selection were kept.'
    );
  }
  const bindingDeferred = !equal(candidate, options.candidate);
  return {
    mode: 'gt-gh',
    already: true,
    selectionOnly: true,
    candidate,
    ...(bindingDeferred ? { bindingDeferred: true } : {}),
    ...(bindingDeferred && blocked ? { bindingBlocked: true } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(after.nativeAbsent
      ? {}
      : { backup: sessionDirectory(repo, after.session) }),
    ...(reason
      ? {
          warnings: [
            `${reason}\nExisting clone routing can resume without a metadata handoff. ` +
              'The current runtime, operation journals, and recovery data are retained. ' +
              'Continue or abort paused clone work in its original worktree; ' +
              'reconcile any newer native work before recovery. ' +
              'Wait for active commands or repair damaged recovery state before updating.' +
              (bindingDeferred
                ? ' Runtime update deferred; rerun gt-cli enable after recovery.'
                : ''),
          ],
        }
      : {}),
  };
}
