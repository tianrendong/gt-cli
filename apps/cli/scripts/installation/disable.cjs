#!/usr/bin/env node
// Escape coordinator intentionally uses only builtins and dependency-free helpers.
// The normal, safety-checked migration runs in a bounded, disposable process group.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const recovery = require('./native_escape.cjs');
const { color, diagnostic, help } = require('./output.cjs');
const HELP = `gt-cli disable [--repo PATH | --global] [--dry-run] [--json]

Return to native Graphite even if gt-cli state or metadata handoff is broken.
Safe metadata migration is best-effort. Failures warn and retain recovery data;
commits, working files, and pending operation journals are never reset.
Pause running stack commands before using native Graphite to change a stack.
--global returns every repository to native; otherwise select the current repo.
--dry-run previews routing and handoff warnings without changing either.
--gt-path PATH asserts the existing gt entry selected by PATH.
--status inspects selection without switching.
Native Graphite must still be installed and its PATH entry must be writable.`;
const BUDGET_MS = 30_000;
function parse(args) {
  const values = new Set(['--repo', '--cwd', '--gt-path']);
  const flags = new Set([
    '--global',
    '--dry-run',
    '--json',
    '--status',
    '--help',
    '-h',
    '--no-interactive',
    '--restore-missing-parents',
  ]);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const [key, ...rest] = args[i].split('=');
    if (values.has(key)) {
      const value = rest.length ? rest.join('=') : args[++i];
      if (!value || value.startsWith('--'))
        throw Error(`Missing value for ${key}.`);
      options[key.slice(2)] = value;
    } else if (flags.has(args[i])) options[args[i].replace(/^--?/, '')] = true;
    else throw Error(`Unsupported switch argument ${args[i]}.`);
  }
  if (
    options.global &&
    (options.repo || options.cwd || options['restore-missing-parents'])
  )
    throw Error(
      '--global changes the default for all repositories. Do not combine it with --repo, --cwd, or --restore-missing-parents.'
    );
  return options;
}
function commandDirectory() {
  const root = path.resolve(__dirname, '../..');
  return fs.existsSync(path.join(root, 'src/toggle_commands.js'))
    ? path.join(root, 'src')
    : path.join(root, 'dist/src');
}
/** Kill only the process group we started, including a possibly busy SQLite
 * child. Do not leave a timed-out exporter writing after native routing returns. */
function worker(script, args, timeoutMs) {
  if (timeoutMs <= 0)
    return Promise.resolve({
      error: 'Metadata handoff time budget exhausted.',
    });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      error;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    };
    const timer = setTimeout(() => {
      error = `Metadata handoff timed out after ${timeoutMs} ms. Its worker was stopped; recovery files were retained.`;
      kill();
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.length > 8 * 1024 * 1024) {
        error = 'Metadata handoff output exceeded its limit.';
        kill();
      }
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-32_768);
    });
    child.once('error', (cause) => {
      error = cause.message;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (!error && code === 0) {
        try {
          return resolve({ result: JSON.parse(stdout), stderr });
        } catch (cause) {
          error = `Metadata handoff returned invalid output: ${cause.message}`;
        }
      }
      resolve({
        error: error || stderr.trim() || `Metadata handoff exited ${code}.`,
      });
    });
  });
}
function previousEscape(file) {
  try {
    const value = recovery.read(file);
    if (value === undefined) return undefined;
    try {
      return (
        JSON.parse(value).reason ||
        'An earlier disable retained incomplete metadata handoff state.'
      );
    } catch {
      return 'An earlier disable selected native routing. Its recovery marker is unreadable; no export was replayed.';
    }
  } catch (error) {
    return `Native-only selection exists but cannot be read: ${error.message}. No export was replayed.`;
  }
}
function worktree(common) {
  const result = spawnSync(
    'git',
    ['--git-dir', common, 'worktree', 'list', '--porcelain', '-z'],
    {
      encoding: 'utf8',
      timeout: 5000,
    }
  );
  if (result.status !== 0)
    throw Error(
      result.stderr?.trim() ||
        result.error?.message ||
        'Registered Git directory is unavailable.'
    );
  for (const field of result.stdout.split('\0')) {
    if (!field.startsWith('worktree ')) continue;
    const cwd = field.slice(9);
    try {
      if (recovery.commonDirectory(cwd) === fs.realpathSync(common)) return cwd;
    } catch {
      /* Try a surviving linked worktree without pruning anything. */
    }
  }
  throw Error('No accessible worktree was found.');
}
async function fallback(options, failure, deadline, dryRun) {
  const plan = recovery.inspectLauncher(options['gt-path']);
  const native = recovery.nativeBinary(plan);
  const warnings = [
    ...plan.warnings,
    `Metadata handoff incomplete: ${failure.replace(/^ERROR:\s*/, '')}`,
  ];
  const completed = [];
  let common,
    global = Boolean(options.global);
  if (!global) {
    try {
      common = recovery.commonDirectory(
        path.resolve(options.repo || options.cwd || process.cwd())
      );
    } catch (error) {
      global = true;
      warnings.push(
        `Repository could not be inspected: ${error.message}. ${
          dryRun ? 'Would restore' : 'Restoring'
        } native Graphite globally instead.`
      );
    }
  }
  if (!global && !plan.record) {
    global = true;
    warnings.push(
      `Launcher registrations are unreadable. ${
        dryRun ? 'Would restore' : 'Restoring'
      } native Graphite globally; all recovery data is retained.`
    );
  }
  if (global && !previousEscape(recovery.globalMarker(plan))) {
    // One broken/offline checkout must not prevent handoff of healthy ones.
    const registered = Array.isArray(plan.record?.repositories)
      ? plan.record.repositories
      : [];
    for (const registeredCommon of [...new Set(registered)]) {
      if (
        typeof registeredCommon !== 'string' ||
        !path.isAbsolute(registeredCommon)
      )
        continue;
      let accessible = false;
      try {
        if (Date.now() >= deadline)
          throw Error(
            'Metadata handoff time budget exhausted. Registration retained in the recovery archive.'
          );
        const escaped = previousEscape(recovery.marker(registeredCommon));
        if (escaped) throw Error(escaped);
        const cwd = worktree(registeredCommon);
        accessible = true;
        const attempt = await worker(
          path.join(commandDirectory(), 'switch_cli.js'),
          [
            'disable',
            '--repo',
            cwd,
            '--graphite',
            native.path,
            '--json',
            ...(dryRun ? ['--dry-run'] : []),
          ],
          Math.max(0, deadline - Date.now())
        );
        if (attempt.error) throw Error(attempt.error);
        if (attempt.result?.mode !== 'graphite')
          throw Error('An interrupted handoff still requires recovery.');
        completed.push(cwd);
      } catch (error) {
        warnings.push(`${registeredCommon}: ${error.message}`);
        if (!dryRun && accessible) {
          try {
            recovery.atomicWrite(
              recovery.marker(registeredCommon),
              JSON.stringify({
                schemaVersion: 1,
                native: native.path,
                handoff: 'incomplete',
                reason: error.message,
                id: require('crypto').randomBytes(12).toString('hex'),
              }) + '\n'
            );
          } catch (error) {
            warnings.push(
              `Recovery data at ${registeredCommon} was left in place: ${error.message}`
            );
          }
        }
      }
    }
  }
  warnings.push(
    'Native Graphite stack metadata may be stale or incomplete. Inspect it with gt log; use native gt init/gt track as needed before restack or submit.',
    'Stop running gt-cli commands before making native stack changes. Pending clone operations may need their original runtime to recover; do not delete operation journals or blindly replay backups.'
  );
  if (common)
    warnings.push(
      `Recovery metadata retained at ${path.join(
        common,
        'gt-gh-switch'
      )}; branch refs and working files were not reset.`
    );
  const launcher = dryRun
    ? undefined
    : recovery.escape(plan, native, {
        common,
        global,
        warnings,
        reason: failure,
      });
  return {
    ...(global || launcher?.global ? { scope: 'global' } : {}),
    mode: 'graphite',
    disabled: !dryRun,
    handoff: 'incomplete',
    gt: plan.slot,
    native: native.path,
    warnings: [...new Set(warnings)],
    ...(global || launcher?.global
      ? {
          repositories: [],
          completed,
          forgotten: [],
          restored: launcher?.restored || false,
        }
      : {}),
    ...(launcher ? { launcher } : {}),
    ...(launcher?.backup ? { backup: launcher.backup } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
}
function report(result, json, cwd) {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.selectionOnly) {
    console.log(
      color(
        'stdout',
        result.dryRun ? 'cyan' : 'green',
        `${result.dryRun ? 'Would select' : 'Selected'} graphite for ${cwd}.`
      )
    );
    console.log(
      `Repository remains uninitialized. Run ${color(
        'stdout',
        'cyan',
        'gt init --trunk <branch>'
      )}.`
    );
    return;
  }
  console.log(
    color(
      'stdout',
      result.dryRun ? 'cyan' : 'green',
      `${
        result.dryRun ? 'Preview: gt would use' : 'gt now uses'
      } native Graphite${
        result.scope === 'global' ? ' globally' : ` for ${cwd}`
      }.`
    )
  );
  if (result.branches !== undefined)
    console.log(
      color(
        'stdout',
        'dim',
        `Verified ${result.branches} tracked branches with native Graphite.`
      )
    );
  if (result.backup)
    console.log(color('stdout', 'dim', `Recovery backup: ${result.backup}`));
  if (result.launcher?.restored || result.restored)
    console.log(color('stdout', 'dim', 'Native gt PATH entry restored.'));
  for (const forgotten of result.forgotten || []) {
    console.log(
      color(
        'stdout',
        'yellow',
        `${result.dryRun ? 'Would forget' : 'Forgot'} missing checkout: ${
          forgotten.repository
        }`
      )
    );
  }
  for (const warning of result.warnings || [])
    console.error(diagnostic('stderr', 'yellow', `WARNING: ${warning}`));
  if (result.dryRun)
    console.log(
      'Preview only. No executable, repository metadata, or backend selection changed.'
    );
}
async function main(args = process.argv.slice(2)) {
  const options = parse(args);
  if (options.help || options.h) {
    console.log(options.json ? HELP : help(HELP));
    return;
  }
  const deadline = Date.now() + BUDGET_MS;
  let previous, initial;
  // Repeated disable must not export stale clone state over work done natively.
  try {
    initial = recovery.inspectLauncher(options['gt-path']);
    previous = previousEscape(recovery.globalMarker(initial));
    if (!options.global) {
      const common = recovery.commonDirectory(
        path.resolve(options.repo || options.cwd || process.cwd())
      );
      previous = previousEscape(recovery.marker(common)) || previous;
    } else {
      for (const common of Object.keys(initial.record?.implementations || {})) {
        if (!path.isAbsolute(common)) continue;
        const reason = previousEscape(recovery.marker(common));
        if (reason) previous = `${common}: ${reason}`;
      }
    }
  } catch {
    /* Normal attempt may work; recovery diagnoses the actual blocker. */
  }
  if (options.status && previous && initial) {
    console.log(
      JSON.stringify({
        mode: 'graphite',
        handoff: 'incomplete',
        warnings: [previous],
        gt: initial.slot,
        native: recovery.nativeBinary(initial).path,
        ...(options.global ? { scope: 'global' } : {}),
      })
    );
    return;
  }
  const attempted = previous
    ? { error: previous }
    : await worker(
        path.join(commandDirectory(), 'toggle_commands.js'),
        [
          'disable',
          ...args.filter((arg) => arg !== '--json'),
          '--json',
          ...(initial && !options['gt-path']
            ? ['--gt-path', initial.slot]
            : []),
        ],
        Math.max(0, deadline - Date.now())
      );
  if (options.status) {
    if (attempted.error) throw Error(attempted.error);
    console.log(JSON.stringify(attempted.result));
    return;
  }
  if (!attempted.error && initial && attempted.result?.gt !== initial.slot)
    attempted.error =
      'The selected gt PATH entry changed during handoff. Restoring the original managed entry instead.';
  if (!attempted.error && attempted.result?.mode === 'graphite') {
    report(
      {
        ...attempted.result,
        disabled: !options['dry-run'],
        handoff: 'complete',
        warnings: attempted.stderr?.trim() ? [attempted.stderr.trim()] : [],
      },
      options.json,
      path.resolve(options.repo || options.cwd || process.cwd())
    );
    return;
  }
  const result = await fallback(
    options,
    attempted.error || 'An interrupted handoff still requires recovery.',
    deadline,
    Boolean(options['dry-run'])
  );
  report(
    result,
    options.json,
    path.resolve(options.repo || options.cwd || process.cwd())
  );
}
module.exports = { main, parse, worker };
if (require.main === module)
  main().catch((error) => {
    const message = `ERROR: ${error.message}`;
    console.error(
      process.argv.includes('--json') || process.argv.includes('--status')
        ? message
        : diagnostic('stderr', 'red', message)
    );
    process.exitCode = 1;
  });
