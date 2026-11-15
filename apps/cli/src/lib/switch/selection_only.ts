import { Repository, fail } from './repository';
import { readState } from './state';
import { repositoryInitialized } from './initialization';
import {
  LauncherPlan,
  withLauncher,
  installLauncher,
  releaseRepository,
} from './launcher';
import { Implementation, saveImplementation } from './selection';
import { registrationSnapshot } from './registration';

type SelectionResult = {
  mode: Implementation;
  initialized: boolean;
  selectionOnly: boolean;
  gt: string;
  native: string;
  dryRun?: boolean;
};

/** Persist only implementation configuration; do not create Git/backend state. */
export async function selectUninitialized(
  repo: Repository,
  options: {
    initial: LauncherPlan;
    mode: Implementation;
    dispatcher: string;
    dryRun: boolean;
  }
): Promise<SelectionResult> {
  const result = {
    mode: options.mode,
    initialized: false,
    selectionOnly: true,
    gt: options.initial.slot,
    native: options.initial.native.path,
    ...(options.dryRun ? { dryRun: true } : {}),
  };
  if (options.dryRun) return result;
  return withLauncher(
    options.initial.slot,
    async (plan) => {
      if (readState(repo) || repositoryInitialized(repo))
        fail(
          'Repository was initialized while selecting its implementation. Retry to perform a safe handoff.'
        );
      const record = installLauncher(plan, options.dispatcher);
      const updated = saveImplementation(plan, record, {
        common: repo.common,
        mode: options.mode,
        worktrees: registrationSnapshot(repo, 'explicit').worktrees,
      });
      releaseRepository(plan, updated);
      return result;
    },
    0
  );
}
