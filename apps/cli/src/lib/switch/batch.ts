import fs from 'fs';
import { execFileSync } from 'child_process';
import { CandidateBinary, readState } from './state';
import { Repository, RepositoryMissingError, fail } from './repository';
import { ExitFailedError } from '../errors';
import {
  canonicalRegistrationPath,
  definitelyMissing,
  canForget,
  automaticForgetBlocker,
  forgetRegistration,
  ForgottenRepository,
  forgottenSummary,
} from './registration';
import {
  LauncherPlan,
  LauncherRecord,
  planLauncher,
  withLauncher,
  setGlobalMode,
  releaseRepository,
} from './launcher';
import { switchBackend, SwitchResult } from './transition';
import { updateBindingIntent } from './binding_update';
import { clearCloneSelections } from './selection';

const FORGET_HINT =
  'Restore this checkout at its registered location. If it was permanently deleted, explicitly remove its saved gt registration with gt-cli forget --repo PATH (use the registered Git directory above) or gt-cli forget --missing.\n' +
  'No registration was removed automatically.';

function unavailableRepository(common: string, reason: string): never {
  return fail(`${reason}\nRegistered Git directory: ${common}\n${FORGET_HINT}`);
}

/** Deletion must be certain before it is reported as such; EACCES, ENOTDIR, and
 * dangling symlinks are repair problems, not stale registrations. */
function certainlyMissing(common: string): boolean {
  try {
    return definitelyMissing(canonicalRegistrationPath(common));
  } catch {
    return false;
  }
}

export function workingDirectory(common: string): string {
  if (certainlyMissing(common))
    throw new RepositoryMissingError(
      `Registered Git directory is missing.\nRegistered Git directory: ${common}\n${FORGET_HINT}`
    );
  if (!fs.existsSync(common))
    return unavailableRepository(
      common,
      'Registered Git directory is inaccessible.'
    );
  let worktrees: string;
  try {
    worktrees = execFileSync(
      'git',
      ['--git-dir', common, 'worktree', 'list', '--porcelain', '-z'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      }
    );
  } catch (error) {
    return unavailableRepository(
      common,
      `Git cannot read this registered repository.\n${
        error.stderr?.toString().trim() || error.message
      }`
    );
  }
  const roots = worktrees
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9));
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const repo = new Repository(root);
    if (fs.realpathSync(repo.common) === fs.realpathSync(common)) return root;
  }
  return unavailableRepository(common, 'No accessible worktree was found.');
}

/** Name every unavailable registration at once; one stale entry must not hide
 * the others behind repeated attempts. Nothing is forgotten here. */
function locateRegistered(
  kind: 'enable' | 'disable',
  registered: string[],
  record: LauncherRecord | undefined
): { common: string; cwd: string }[] {
  const unavailable: { common: string; missing: boolean; reason: string }[] =
    [];
  const located = registered.flatMap((common) => {
    try {
      return [{ common, cwd: workingDirectory(common) }];
    } catch (error) {
      if (!(error instanceof ExitFailedError)) throw error;
      const missing = error instanceof RepositoryMissingError;
      let reason = error.message.split('\nRegistered Git directory:')[0];
      if (missing && record) {
        try {
          const retained = automaticForgetBlocker(record, common);
          if (retained) reason += '\n' + retained;
        } catch (error) {
          reason += '\n' + error.message;
        }
      }
      unavailable.push({ common, missing, reason });
      return [];
    }
  });
  if (unavailable.length)
    fail(
      `Global ${kind} needs every registered repository.\n${unavailable
        .map(
          ({ common, reason }) =>
            `  - ${common}\n      ${reason.replace(/\n/g, '\n      ')}`
        )
        .join('\n')}\n` +
        'Restore each checkout at its registered location, or explicitly forget a permanently deleted one with gt-cli forget --repo PATH' +
        (unavailable.some((entry) => entry.missing)
          ? ' (preview bulk cleanup with gt-cli forget --missing --dry-run).'
          : '.') +
        '\nNo registration was removed automatically.'
    );
  return located;
}

function cleanupCandidates(plan: LauncherPlan, registered: string[]): string[] {
  return registered.filter((common) => {
    try {
      return plan.record && canForget(plan.record, common, true);
    } catch {
      // Unreadable/unverifiable paths still go through normal preflight.
      return false;
    }
  });
}

export type GlobalResult = {
  scope: 'global';
  mode: 'gt-gh' | 'graphite';
  gt: string;
  repositories: string[];
  completed: string[];
  forgotten: { repository: string }[];
  restored: boolean;
  dryRun?: boolean;
  warnings?: string[];
  /** Routing succeeds, but these repositories retain their existing runtime. */
  deferred?: string[];
};

type GlobalTarget = { common: string; cwd: string; skip: boolean };

function globalTargets(
  kind: 'enable' | 'disable',
  plan: LauncherPlan
): { registered: string[]; missing: string[]; targets: GlobalTarget[] } {
  const registered = [...new Set(plan.record?.repositories ?? [])];
  const missing = cleanupCandidates(plan, registered);
  const targets = locateRegistered(
    kind,
    registered.filter((common) => !missing.includes(common)),
    plan.record
  ).map(({ common, cwd }) => {
    const state = readState(new Repository(cwd));
    if (kind === 'enable' && state?.mode === 'disabling')
      fail(`Finish the interrupted disable for ${cwd} before global enable.`);
    return {
      common,
      cwd,
      skip: kind === 'enable' && state?.mode === 'graphite',
    };
  });
  return { registered, missing, targets };
}

function clearBindingIntent(plan: LauncherPlan, common: string): void {
  const current = planLauncher(plan.slot);
  if (current.record?.pendingBindings?.repositories.includes(common))
    updateBindingIntent(current, current.record, { common });
}

/** Actual results replace previews, including a repository becoming idle. */
class BindingResults {
  private readonly warnings = new Map<string, string[]>();
  readonly deferred = new Map<string, string>();
  readonly retry = new Set<string>();

  note(target: GlobalTarget, changed: SwitchResult): void {
    this.warnings.set(target.cwd, changed.warnings ?? []);
    if (changed.bindingDeferred) this.deferred.set(target.cwd, target.common);
    else this.deferred.delete(target.cwd);
    if (changed.bindingDeferred && !changed.bindingBlocked)
      this.retry.add(target.common);
    else this.retry.delete(target.common);
  }

  report(result: GlobalResult): GlobalResult {
    const warnings = [...this.warnings].flatMap(([cwd, entries]) =>
      entries.map((message) => `${cwd}: ${message}`)
    );
    return {
      ...result,
      ...(warnings.length ? { warnings } : {}),
      ...(this.deferred.size ? { deferred: [...this.deferred.keys()] } : {}),
    };
  }
}

export async function switchGlobal(
  kind: 'enable' | 'disable',
  {
    initial,
    candidate,
    dispatcher,
    dryRun,
  }: {
    initial: LauncherPlan;
    candidate: CandidateBinary;
    dispatcher: string;
    dryRun: boolean;
  }
): Promise<GlobalResult> {
  const forgotten: ForgottenRepository[] = [];
  const perform = async (plan: LauncherPlan): Promise<GlobalResult> => {
    const { registered, missing, targets } = globalTargets(kind, plan);
    const bindings = new BindingResults();
    // Real migrations still preflight before any writes. Existing clone owners
    // can resume routing while paused or busy, retaining their pinned runtime.
    for (const target of targets)
      if (!target.skip)
        bindings.note(
          target,
          await switchBackend(kind, {
            repo: target.cwd,
            candidate,
            graphite: plan.native.path,
            dryRun: true,
            nonBlocking: true,
          })
        );
    const result: GlobalResult = {
      scope: 'global',
      mode: kind === 'enable' ? 'gt-gh' : 'graphite',
      gt: plan.slot,
      repositories: registered,
      completed: [],
      forgotten: dryRun
        ? missing.map((repository) => ({ repository }))
        : forgotten,
      restored: false,
      ...(dryRun ? { dryRun: true } : {}),
    };
    if (dryRun) return bindings.report(result);
    // Preflight all remaining repositories before any cleanup. Recheck each
    // missing path inside forgetRegistration before removal.
    for (const common of missing)
      forgotten.push(forgetRegistration(plan, plan.record!, common, true));
    // Keep the previous dispatcher while bindings change. It can delegate to new
    // candidates, without forcing unrelated repositories onto an old saved Node.
    if (kind === 'disable') {
      clearCloneSelections(plan);
      const changed = setGlobalMode(
        plan,
        plan.record?.dispatcher ?? dispatcher,
        false
      );
      result.restored = changed.restored;
    }
    for (const target of targets) {
      try {
        if (!target.skip) {
          bindings.note(
            target,
            await switchBackend(kind, {
              repo: target.cwd,
              candidate,
              graphite: plan.native.path,
              nonBlocking: true,
            })
          );
          result.completed.push(target.cwd);
          if (kind === 'enable') clearBindingIntent(plan, target.common);
        }
        if (kind === 'disable' || target.skip) {
          const current = planLauncher(plan.slot);
          if (current.record && current.record.phase !== 'restored') {
            const released = releaseRepository(
              current,
              current.record,
              target.common
            );
            result.restored = released.restored;
          }
        }
      } catch (error) {
        fail(
          `Global ${kind} stopped at ${target.cwd}: ${
            error.message
          }\nCompleted: ${
            result.completed.join(', ') || 'none'
          }. Current work was kept. Rerun the same command after resolving the blocker; do not uninstall.`
        );
      }
    }
    if (kind === 'enable') {
      // Clear superseded per-repository intent above before queuing this global
      // target, so an old shared target cannot strand the first busy repository.
      for (const common of bindings.retry) {
        const current = planLauncher(plan.slot);
        if (current.record)
          updateBindingIntent(current, current.record, { common, candidate });
      }
      setGlobalMode(planLauncher(plan.slot), dispatcher, true);
    }
    result.repositories = planLauncher(plan.slot).record?.repositories ?? [];
    return bindings.report(result);
  };
  try {
    return await (dryRun
      ? perform(initial)
      : withLauncher(initial.slot, perform, 0));
  } catch (error) {
    if (forgotten.length)
      fail(`${error.message}\n${forgottenSummary(forgotten)}`);
    throw error;
  }
}
