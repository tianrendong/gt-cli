import path from 'path';
import { CandidateBinary } from './state';
import { Repository } from './repository';
import { workingDirectory } from './batch';
import { withLauncher, setGlobalMode } from './launcher';
import { atomicJSON } from '../github/stack_file';
import { ExitFailedError } from '../errors';
import {
  BindingFailure,
  describeBindingFailure,
  refreshBinding,
} from './binding_update';
import {
  automaticForgetBlocker,
  forgetRegistration,
  ForgottenRepository,
  forgottenSummary,
  registrationSnapshot,
} from './registration';

export class BindingUpgradeError extends ExitFailedError {
  constructor(
    error: unknown,
    readonly updatePhase: 'preflight' | 'activation'
  ) {
    super(error instanceof Error ? error.message : String(error));
  }
}

export type DeferredBinding = {
  repository: string;
  /** Why an absent registration was retained rather than automatically cleaned. */
  retained?: string;
} & BindingFailure;
export type UpgradeResult = {
  repositories: string[];
  deferred: DeferredBinding[];
  forgotten: ForgottenRepository[];
  global: boolean;
};

/**
 * Install updates independently of repository activity. Persist desired bindings
 * before trying any refresh, so a busy repository catches up on its next idle
 * invocation even after a crash. Old installations stay intact for commands
 * already running and for continue/abort of paused operations.
 */
export async function upgradeBindings({
  slot,
  candidate,
  dispatcher,
  beforeChange,
  finish,
}: {
  slot: string;
  candidate: CandidateBinary;
  dispatcher: string;
  beforeChange: () => void;
  finish: () => void;
}): Promise<UpgradeResult> {
  let phase: 'preflight' | 'activation' = 'preflight';
  const forgotten: ForgottenRepository[] = [];
  try {
    return await withLauncher(slot, async (plan) => {
      const registered = [...new Set(plan.record?.repositories ?? [])].sort();
      beforeChange();
      phase = 'activation';
      const record = plan.record;
      const file = path.join(plan.directory, 'launcher.json');
      if (record && registered.length) {
        record.pendingBindings = { candidate, repositories: registered };
        atomicJSON(file, record);
      }
      const repositories: string[] = [];
      const deferred: DeferredBinding[] = [];
      // Clean up deleted checkouts before refreshing the survivors: refreshed
      // device observations would erase the record's evidence that a reboot
      // merely renumbered a still-mounted volume (see automaticForgetBlocker).
      const decisions = new Map<
        string,
        { retained?: string; error?: unknown }
      >();
      const remaining = registered.filter((common) => {
        if (!record) return true;
        try {
          const retained = automaticForgetBlocker(record, common);
          if (retained) {
            decisions.set(common, { retained });
            return true;
          }
          forgotten.push(forgetRegistration(plan, record, common, true));
          return false;
        } catch (error) {
          decisions.set(common, { error });
          return true;
        }
      });
      for (const common of remaining) {
        const { retained, error: undecided } = decisions.get(common) ?? {};
        try {
          if (undecided) throw undecided;
          const repo = new Repository(workingDirectory(common));
          if (refreshBinding(repo, candidate)) repositories.push(repo.cwd);
          const previous = record?.registrations?.[common];
          if (record?.registrations && previous) {
            const snapshot = registrationSnapshot(repo, previous.source);
            record.registrations[common] = {
              ...snapshot,
              pathDevices: { ...previous.pathDevices, ...snapshot.pathDevices },
              pathMounts: { ...previous.pathMounts, ...snapshot.pathMounts },
              worktrees: [
                ...new Set([...previous.worktrees, ...snapshot.worktrees]),
              ],
            };
          }
        } catch (error) {
          const failure = describeBindingFailure(error);
          deferred.push({
            repository: common,
            ...failure,
            ...(failure.kind === 'missing' && retained ? { retained } : {}),
          });
        }
      }
      if (record) {
        if (deferred.length)
          record.pendingBindings = {
            candidate,
            repositories: deferred.map((binding) => binding.repository),
          };
        else delete record.pendingBindings;
        atomicJSON(file, record);
      }
      const global = record?.defaultMode === 'gt-gh';
      if (
        record &&
        record.phase !== 'restored' &&
        (record.dispatcher !== dispatcher || record.node !== candidate.node)
      )
        setGlobalMode(plan, dispatcher, global);
      finish();
      return { repositories, deferred, forgotten, global };
    });
  } catch (error) {
    const reported = forgotten.length
      ? new Error(
          `${describeBindingFailure(error).reason}\n${forgottenSummary(
            forgotten
          )}`
        )
      : error;
    throw new BindingUpgradeError(reported, phase);
  }
}
