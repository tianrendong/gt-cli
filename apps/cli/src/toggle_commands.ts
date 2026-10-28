#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { color, diagnostic, help } from '../scripts/installation/output.cjs';
import {
  clearSelection,
  selectionSnapshot,
} from '../scripts/installation/native_escape.cjs';
import { Repository, fail } from './lib/switch/repository';
import { readState, nativeDatabasePresent } from './lib/switch/state';
import { assertBundledSqliteRuntime } from './lib/switch/sqlite';
import { switchGlobal } from './lib/switch/batch';
import { repositoryInitialized } from './lib/switch/initialization';
import { implementationFor, saveImplementation } from './lib/switch/selection';
import { selectUninitialized } from './lib/switch/selection_only';
import { updateBindingIntent } from './lib/switch/binding_update';
import {
  canonicalRegistrationPath,
  forgetRegistration,
  canForget,
  missingRegistrations,
  registrationSnapshot,
} from './lib/switch/registration';
import {
  switchBackend,
  SwitchOptions,
  SwitchResult,
} from './lib/switch/transition';
import {
  installLauncher,
  planLauncher,
  registerRepository,
  releaseRepository,
  withLauncher,
  savedLauncherRecord,
} from './lib/switch/launcher';

type ToggleResult = SwitchResult & {
  gt: string;
  native: string;
  launcher?: ReturnType<typeof releaseRepository>;
};
const kind = process.argv[2];
const args = process.argv.slice(3);
const machineOutput = args.includes('--json') || args.includes('--status');
const values = new Set(['--repo', '--cwd', '--gt-path']);
const flags = new Set([
  '--dry-run',
  '--global',
  '--missing',
  '--restore-missing-parents',
  '--json',
  '--status',
  '--no-interactive',
  '--help',
  '-h',
]);
function value(flag: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(flag + '='));
  if (eq) return eq.slice(flag.length + 1);
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith('--'))
    fail(`Missing value for ${flag}.`);
  return args[at + 1];
}
function validateArgs(): void {
  if (!['enable', 'disable', 'forget'].includes(kind))
    fail('Use gt-cli enable, disable, or forget.');
  if (kind !== 'forget' && args.includes('--missing'))
    fail('--missing is only supported by gt-cli forget.');
  for (let i = 0; i < args.length; i++) {
    if (values.has(args[i])) {
      value(args[i]);
      i++;
      continue;
    }
    if (
      flags.has(args[i]) ||
      [...values].some((flag) => args[i].startsWith(flag + '='))
    )
      continue;
    fail(
      `Unsupported switch argument ${args[i]}. No force bypass is available.`
    );
  }
}
const HELP = `gt-cli <enable|disable> [--repo PATH | --global] [--dry-run] [--json]

Normal commands stay gt. No pi-stack changes, aliases, PATH edits, or agent reloads.
Enable selects our implementation at the existing gt PATH entry. Fresh repositories
stay uninitialized: run gt init explicitly. Existing setup is migrated safely when
needed; disable returns native routing even if metadata handoff fails, with warnings
and recovery data retained. Native Graphite's executable and authentication stay intact.
Safety checks and backups still protect metadata writes. Re-enable can restore an
existing clone without waiting for paused operations; its runtime and journals stay
pinned until recovery finishes. New metadata migrations still require idle worktrees.

Run install.sh once; it provides a private Node runtime and bundled SQLite.
Pause gt commands/agents in affected worktrees before a metadata migration.
Validated migration requires Graphite 1.8.6. Routing requires a writable gt PATH entry.
--dry-run is optional inspection.
--global enable: select the clone by default; only already-initialized repositories migrate on first use.
--global disable: best-effort handoff, then native routing even for broken or offline repositories.
Global switches automatically forget absent checkouts after safety checks.
Global enable preserves explicit per-repository native opt-outs.
--restore-missing-parents: opt in to exact recorded ancestor recovery on enable.
--gt-path PATH: assert which existing gt entry will be replaced (not a new PATH slot).
--status: inspect selection without switching. No branch tips or working files reset.
Remote pushes/PR edits are not undone. Never remove an installation still in use.`;

const FORGET_USAGE =
  'Use gt-cli forget --repo PATH [--dry-run] [--json] or gt-cli forget --missing [--dry-run] [--json]. Only deleted checkouts can be forgotten.';

/** Every registration whose Git directory is gone. Same per-repository rules
 * as --repo; explicit and previewable. */
async function forgetMissing(): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const initial = planLauncher(value('--gt-path'));
  const forgotten = await withLauncher(
    initial.slot,
    async (plan): Promise<{ repository: string }[]> => {
      const record = savedLauncherRecord(plan);
      const missing = record ? missingRegistrations(record) : [];
      return dryRun
        ? missing.map((repository) => ({ repository }))
        : missing.map((common) =>
            forgetRegistration(plan, record!, common, false)
          );
    }
  );
  if (args.includes('--json')) {
    console.log(JSON.stringify({ forgotten, ...(dryRun ? { dryRun } : {}) }));
    return;
  }
  if (!forgotten.length) {
    console.log(
      'No missing registrations eligible for cleanup. Existing or unverifiable paths were kept.'
    );
    return;
  }
  const plural = forgotten.length === 1 ? 'registration' : 'registrations';
  console.log(
    color(
      'stdout',
      dryRun ? 'cyan' : 'green',
      `${dryRun ? 'Would forget' : 'Forgot'} ${
        forgotten.length
      } missing ${plural}:`
    )
  );
  for (const entry of forgotten) {
    console.log(
      color('stdout', dryRun ? 'cyan' : 'green', `  - ${entry.repository}`)
    );
  }
  if (dryRun)
    console.log('Preview only. No registration, file, or executable changed.');
}

async function forget(): Promise<void> {
  const batch = args.includes('--missing');
  if (
    (batch ? value('--repo') !== undefined : !value('--repo')) ||
    args.some(
      (arg) =>
        ['--global', '--status', '--restore-missing-parents', '--cwd'].includes(
          arg
        ) || arg.startsWith('--cwd=')
    )
  )
    fail(FORGET_USAGE);
  if (batch) return forgetMissing();
  const requested = canonicalRegistrationPath(value('--repo')!);
  const initial = planLauncher(value('--gt-path'));
  const result = await withLauncher(initial.slot, async (plan) => {
    const record = savedLauncherRecord(plan);
    const matches =
      [
        ...new Set([
          ...(record?.repositories ?? []),
          ...Object.keys(record?.implementations ?? {}),
        ]),
      ].filter(
        (common) =>
          common === requested ||
          (path.basename(common) === '.git' &&
            path.dirname(common) === requested) ||
          record?.registrations?.[common]?.worktrees.includes(requested) ||
          record?.implementations?.[common]?.worktrees.includes(requested)
      ) ?? [];
    if (matches.length !== 1)
      fail(
        'Path must identify exactly one saved registration. Pass its registered Git directory if ambiguous.'
      );
    const common = matches[0];
    if (!canForget(record!, common, false))
      fail(
        'Registered Git directory still exists or is not safely accessible. Use gt-cli disable for an existing repository.'
      );
    return args.includes('--dry-run')
      ? { repository: common, dryRun: true }
      : forgetRegistration(plan, record!, common, false);
  });
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else {
    console.log(
      color(
        'stdout',
        args.includes('--dry-run') ? 'cyan' : 'green',
        `${
          args.includes('--dry-run') ? 'Would forget' : 'Forgot'
        } registration: ${result.repository}`
      )
    );
  }
}

function reportForgotten(
  entries: { repository: string }[],
  dryRun: boolean
): void {
  for (const { repository } of entries) {
    console.log(
      color(
        'stdout',
        dryRun ? 'cyan' : 'yellow',
        `${dryRun ? 'Would forget' : 'Forgot'} missing checkout: ${repository}`
      )
    );
  }
}

function reportWarnings(warnings: string[] = []): void {
  for (const warning of warnings)
    console.error(diagnostic('stderr', 'yellow', `WARNING: ${warning}`));
}

async function globalToggle(): Promise<void> {
  if (
    value('--repo') !== undefined ||
    value('--cwd') !== undefined ||
    args.includes('--restore-missing-parents')
  )
    fail(
      '--global changes the default for all repositories. Do not combine it with --repo, --cwd, or --restore-missing-parents.'
    );
  const initial = planLauncher(value('--gt-path'));
  const selectionRecord = savedLauncherRecord(initial);
  const escapeSelection = selectionSnapshot(initial, undefined);
  const enabled = kind === 'enable';
  const status = args.includes('--status');
  const dryRun = args.includes('--dry-run');
  if (!status) assertBundledSqliteRuntime();
  const result = status
    ? {
        scope: 'global',
        mode: selectionRecord?.defaultMode ?? 'graphite',
        gt: initial.slot,
        repositories: selectionRecord?.repositories ?? [],
        implementations: selectionRecord?.implementations ?? {},
        restored: false,
      }
    : await switchGlobal(enabled ? 'enable' : 'disable', {
        initial,
        candidate: {
          node: process.execPath,
          script: fs.realpathSync(path.join(__dirname, 'index.js')),
        },
        dispatcher: fs.realpathSync(path.join(__dirname, 'gt_cli.js')),
        dryRun,
      });
  if (enabled && !status && !dryRun) clearSelection(escapeSelection);
  if (args.includes('--json') || status) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(
    color(
      'stdout',
      dryRun ? 'cyan' : 'green',
      `${
        dryRun ? 'Preview: global default would be' : 'Global gt default is'
      } ${enabled ? 'the clone' : 'native Graphite'}.`
    )
  );
  if (dryRun) console.log(color('stdout', 'dim', `gt entry: ${initial.slot}`));
  if (enabled)
    console.log(
      `Initialized repositories migrate on first use; fresh repositories need ${color(
        'stdout',
        'cyan',
        'gt init'
      )}. Native opt-outs stay native.`
    );
  else
    console.log(
      dryRun
        ? 'Every remaining registered repository was preflighted for handoff.'
        : 'Every remaining registered repository was handed back; current work was kept.'
    );
  if ('warnings' in result) reportWarnings(result.warnings);
  if ('forgotten' in result) reportForgotten(result.forgotten, dryRun);
  if (result.repositories.length)
    console.log(
      color(
        'stdout',
        'dim',
        `Registered repositories: ${result.repositories.length}`
      )
    );
  if (result.restored)
    console.log(color('stdout', 'dim', 'Original gt PATH entry restored.'));
  if (dryRun)
    console.log(
      'Preview only. No executable, repository metadata, or backend selection changed.'
    );
}

// eslint-disable-next-line max-lines-per-function
async function main(): Promise<void> {
  validateArgs();
  if (args.includes('--help') || args.includes('-h')) {
    const text =
      kind === 'forget'
        ? 'gt-cli forget --repo PATH [--dry-run] [--json]\ngt-cli forget --missing [--dry-run] [--json]\nExplicitly forget a checkout whose Git directory is gone, or every such registration. Leftover working files are never deleted. Existing, relocated, symlinked, and unreadable Git directories are protected.'
        : HELP;
    console.log(machineOutput ? text : help(text));
    return;
  }
  if (kind === 'forget') return forget();
  if (args.includes('--global')) return globalToggle();
  const repo = new Repository(
    value('--repo') ?? value('--cwd') ?? process.cwd()
  );
  const initial = planLauncher(value('--gt-path'));
  if (args.includes('--status')) {
    const state = readState(repo);
    const selectionRecord = savedLauncherRecord(initial);
    console.log(
      JSON.stringify({
        mode:
          state?.mode ??
          implementationFor(selectionRecord, repo.common) ??
          'graphite',
        initialized: repositoryInitialized(repo),
        implementationOverride:
          selectionRecord?.implementations?.[fs.realpathSync(repo.common)]
            ?.mode,
        globalDefault: selectionRecord?.defaultMode ?? 'graphite',
        migrationRequired:
          !state &&
          implementationFor(selectionRecord, repo.common) === 'gt-gh' &&
          nativeDatabasePresent(repo),
        gt: initial.slot,
        native: initial.native.path,
        launcherInstalled: Boolean(
          initial.record &&
            fs.lstatSync(initial.slot).isSymbolicLink() &&
            fs.readlinkSync(initial.slot) === initial.record.router
        ),
        repositories: initial.record?.repositories ?? [],
      })
    );
    return;
  }
  const escapeSelection = selectionSnapshot(initial, repo.common);
  if (
    kind === 'enable' &&
    escapeSelection[0].content !== undefined &&
    initial.record &&
    initial.record.phase !== 'restored'
  )
    fail(
      'A previous global escape could not finish launcher bookkeeping. Rerun gt-cli disable --global, then retry this enable. Native Graphite remains selected; other repositories must not be re-enabled implicitly.'
    );
  if (!readState(repo) && !repositoryInitialized(repo)) {
    const result = await selectUninitialized(repo, {
      initial,
      mode: kind === 'enable' ? 'gt-gh' : 'graphite',
      dispatcher: fs.realpathSync(path.join(__dirname, 'gt_cli.js')),
      dryRun: args.includes('--dry-run'),
    });
    if (kind === 'enable' && !result.dryRun) clearSelection(escapeSelection);
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else {
      console.log(
        color(
          'stdout',
          result.dryRun ? 'cyan' : 'green',
          `${result.dryRun ? 'Would select' : 'Selected'} ${result.mode} for ${
            repo.cwd
          }.`
        )
      );
      console.log(
        `Repository remains uninitialized. Run ${color(
          'stdout',
          'cyan',
          'gt init --trunk <branch>'
        )}.`
      );
    }
    return;
  }
  const options = (native: string, dryRun: boolean): SwitchOptions => ({
    repo: repo.cwd,
    graphite: native,
    dryRun,
    nonBlocking: true,
    restoreMissingParents: args.includes('--restore-missing-parents'),
    candidate: {
      node: process.execPath,
      script: fs.realpathSync(path.join(__dirname, 'index.js')),
    },
  });
  const switching = kind as 'enable' | 'disable';
  const result: ToggleResult = args.includes('--dry-run')
    ? {
        ...(await switchBackend(switching, options(initial.native.path, true))),
        gt: initial.slot,
        native: initial.native.path,
      }
    : await withLauncher(
        initial.slot,
        async (plan) => {
          // Complete the native metadata rehearsal BEFORE changing the executable.
          await switchBackend(switching, options(plan.native.path, true));
          if (switching === 'enable') {
            let record = installLauncher(
              plan,
              plan.record?.dispatcher ??
                fs.realpathSync(path.join(__dirname, 'gt_cli.js'))
            );
            record = registerRepository(
              plan,
              record,
              repo.common,
              registrationSnapshot(repo, 'explicit')
            );
            try {
              const changed = await switchBackend(
                'enable',
                options(record.native.path, false)
              );
              if (changed.bindingDeferred && !changed.bindingBlocked)
                record = updateBindingIntent(plan, record, {
                  common: repo.common,
                  candidate: options(record.native.path, false).candidate,
                });
              saveImplementation(plan, record, {
                common: repo.common,
                mode: 'gt-gh',
                worktrees: registrationSnapshot(repo, 'explicit').worktrees,
              });
              return { ...changed, gt: plan.slot, native: record.native.path };
            } catch (error) {
              // Before a metadata transition starts, restoring our own PATH entry is
              // safe. Pending/enabled metadata must retain its dispatcher for recovery.
              const state = readState(repo);
              if (!state || state.mode === 'graphite')
                releaseRepository(plan, record, repo.common);
              throw error;
            }
          }
          const record = plan.record
            ? installLauncher(
                plan,
                plan.record?.dispatcher ??
                  fs.realpathSync(path.join(__dirname, 'gt_cli.js'))
              )
            : undefined;
          const changed = await switchBackend(
            'disable',
            options(plan.native.path, false)
          );
          const selected = record
            ? saveImplementation(plan, record, {
                common: repo.common,
                mode: 'graphite',
                worktrees: registrationSnapshot(repo, 'explicit').worktrees,
              })
            : undefined;
          const launcher = selected
            ? releaseRepository(plan, selected, repo.common)
            : { remaining: [], restored: false };
          return {
            ...changed,
            gt: plan.slot,
            native: plan.native.path,
            launcher,
          };
        },
        0
      );
  if (kind === 'enable' && !result.dryRun) clearSelection(escapeSelection);
  if (args.includes('--json')) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(
    color(
      'stdout',
      result.dryRun ? 'cyan' : 'green',
      `${result.dryRun ? 'Preview:' : 'gt now uses'} ${
        result.mode === 'gt-gh' ? 'the clone' : 'native Graphite'
      } for ${repo.cwd}.`
    )
  );
  if (result.dryRun)
    console.log(color('stdout', 'dim', `gt entry: ${result.gt}`));
  if (result.branches !== undefined)
    console.log(
      color(
        'stdout',
        'dim',
        `Verified ${result.branches} tracked branches with native Graphite.`
      )
    );
  for (const branch of result.restored ?? [])
    console.log(
      color(
        'stdout',
        'yellow',
        `Recorded ancestor ${
          result.dryRun ? 'would be restored' : 'restored'
        }: ${branch}`
      )
    );
  reportWarnings(result.warnings);
  if (result.backup)
    console.log(color('stdout', 'dim', `Metadata backup: ${result.backup}`));
  if (result.launcher) {
    if (result.launcher.restored)
      console.log(color('stdout', 'dim', 'Original gt PATH entry restored.'));
    else if (result.launcher.remaining.length)
      console.log(
        color(
          'stdout',
          'dim',
          `Other repositories still using the clone: ${result.launcher.remaining.length}`
        )
      );
  }
  if (result.dryRun)
    console.log('Preview only. No executable or backend selection changed.');
}
void main().catch((error) => {
  const message = `ERROR: ${error.message}`;
  console.error(machineOutput ? message : diagnostic('stderr', 'red', message));
  process.exitCode = 1;
});
