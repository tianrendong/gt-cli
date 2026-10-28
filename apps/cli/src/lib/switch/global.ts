import fs from 'fs';
import { Repository, fail } from './repository';
import { CandidateBinary, readState } from './state';
import {
  launcherFromEnvironment,
  registerRepository,
  releaseRepository,
  withLauncher,
} from './launcher';
import { switchBackend } from './transition';
import { registrationSnapshot } from './registration';
import { implementationFor } from './selection';
import {
  repositoryInitialized,
  INITIALIZATION_REQUIRED,
} from './initialization';

/** Migrate existing setup, or prepare an explicitly requested gt init.
 * A selector alone never authorizes creation of repository setup. Register before
 * durable handoff so interruption cannot strand a clone-owned repository.
 */
export async function adoptGlobalRepository(
  repo: Repository,
  candidate: CandidateBinary,
  initialize = false
): Promise<void> {
  const initial = launcherFromEnvironment();
  if (!initial || implementationFor(initial, repo.common) !== 'gt-gh') return;
  await withLauncher(initial.slot, async (plan) => {
    if (
      !plan.record ||
      implementationFor(plan.record, repo.common) !== 'gt-gh' ||
      readState(repo)
    )
      return;
    if (!initialize && !repositoryInitialized(repo))
      fail(INITIALIZATION_REQUIRED);
    const options = {
      repo: repo.cwd,
      graphite: plan.record.native.path,
      candidate,
    };
    await switchBackend('enable', { ...options, dryRun: true });
    const alreadyRegistered = plan.record.repositories.includes(repo.common);
    const record = registerRepository(
      plan,
      plan.record,
      repo.common,
      registrationSnapshot(
        repo,
        plan.record.implementations?.[fs.realpathSync(repo.common)]?.mode ===
          'gt-gh'
          ? 'explicit'
          : 'adopted'
      )
    );
    try {
      await switchBackend('enable', options);
    } catch (error) {
      const state = readState(repo);
      if (!alreadyRegistered && (!state || state.mode === 'graphite'))
        releaseRepository(plan, record, repo.common);
      throw error;
    }
  });
}
