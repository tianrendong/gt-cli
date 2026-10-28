#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { StackStore } from './lib/github/stack_file';
import { Repository, fail } from './lib/switch/repository';
import { findNative } from './lib/switch/native';
import { readState, verifyNativeBinary } from './lib/switch/state';
import { switchBackend } from './lib/switch/transition';
import { version } from '../package.json';

const CONTROL_VALUES = new Set(['--cwd', '--repo', '--graphite']);
const CONTROL_HELP = `gt-gh — try GitHub-backed stacks alongside Graphite.

  gt-gh enable [--repo PATH]    Back up, validate, and enable for this repository.
  gt-gh disable [--repo PATH]   Hand current work back to native Graphite.
  gt-gh backend [--repo PATH]   Show repository selection.

Enable/disable: --dry-run, --json, --graphite /absolute/path/to/gt.
Enable only: --restore-missing-parents (review --dry-run first).
Pause native gt commands in every worktree before switching.
No existing branch tips or working files are reset. Remote changes are not undone.
Reversible switching requires Graphite 1.8.6 and Node.js 22.16+ (22.x) or 24+ on macOS/Linux.
SQLite is bundled with Node.js; no separate sqlite3 installation is needed.

Run gt-gh <command> --help for commands from the selected backend.`;
const args = process.argv.slice(2);
const optionArgs = args.includes('--')
  ? args.slice(0, args.indexOf('--'))
  : args;
function value(flag: string): string | undefined {
  const eq = optionArgs.find((a) => a.startsWith(flag + '='));
  if (eq) return eq.slice(flag.length + 1);
  const index = optionArgs.indexOf(flag);
  if (index < 0) return undefined;
  if (!optionArgs[index + 1] || optionArgs[index + 1].startsWith('--'))
    fail(`Missing value for ${flag}.`);
  return optionArgs[index + 1];
}
function command(): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (CONTROL_VALUES.has(args[i])) {
      i++;
      continue;
    }
    if (args[i] === '--') return undefined;
    if (!args[i].startsWith('-')) return args[i];
  }
  return undefined;
}
function repository(cwd: string): Repository | undefined {
  const result = spawnSync(
    'git',
    ['-C', cwd, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8', timeout: 10_000 }
  );
  return result.status === 0 ? new Repository(cwd) : undefined;
}
function child(binary: string, argv: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const process = spawn(binary, argv, { cwd, stdio: 'inherit' });
    process.once('error', reject);
    process.once('close', (code) => resolve(code ?? 1));
  });
}
function validateControlArgs(): void {
  const flags = new Set([
    '--dry-run',
    '--restore-missing-parents',
    '--no-interactive',
    '--json',
    '--help',
    '-h',
  ]);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === command()) continue;
    if (CONTROL_VALUES.has(token)) {
      value(token);
      i++;
      continue;
    }
    if (
      [...CONTROL_VALUES].some((v) => token.startsWith(v + '=')) ||
      flags.has(token)
    )
      continue;
    fail(
      `Unsupported switch argument ${token}. No --force bypass is available.`
    );
  }
}
// eslint-disable-next-line max-lines-per-function
async function main(): Promise<void> {
  if (process.env.GT_GH_PROBING_NATIVE)
    fail('gt-gh is not the native Graphite binary.');
  const cmd = command();
  if (!cmd && (optionArgs.includes('--help') || optionArgs.includes('-h'))) {
    console.log(CONTROL_HELP);
    return;
  }
  if (!cmd && optionArgs.includes('--version')) {
    console.log(version);
    return;
  }
  const controlling =
    cmd === 'enable' || cmd === 'disable' || cmd === 'backend';
  const cwd = path.resolve(
    (controlling ? value('--repo') : undefined) ??
      value('--cwd') ??
      process.cwd()
  );
  if (controlling) {
    validateControlArgs();
    if (args.includes('--help') || args.includes('-h')) {
      console.log(CONTROL_HELP);
      return;
    }
    if (cmd === 'backend') {
      const repo = repository(cwd);
      const state = repo && readState(repo);
      console.log(
        JSON.stringify({
          mode:
            state?.mode ??
            (repo && fs.existsSync(repo.db) ? 'graphite' : 'gt-gh'),
          managed: Boolean(state),
          repository: repo?.common,
          native: state?.native.path,
          backup: state
            ? path.join(repo!.control, 'sessions', state.session)
            : undefined,
        })
      );
      return;
    }
    const result = await switchBackend(cmd as 'enable' | 'disable', {
      repo: cwd,
      graphite: value('--graphite'),
      dryRun: args.includes('--dry-run'),
      restoreMissingParents: args.includes('--restore-missing-parents'),
      candidate: {
        node: process.execPath,
        script: fs.realpathSync(__filename),
      },
    });
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else {
      console.log(
        `${
          result.dryRun
            ? 'Preview:'
            : result.already
            ? 'Already using'
            : 'Now using'
        } ${result.mode} for ${cwd}.`
      );
      if (result.branches !== undefined)
        console.log(
          `Verified ${result.branches} tracked branches with native Graphite.`
        );
      for (const branch of result.restored ?? [])
        console.log(
          `Recorded ancestor ${
            result.dryRun ? 'would be restored' : 'restored'
          }: ${branch}`
        );
      if (result.backup) console.log(`Metadata backup: ${result.backup}`);
      console.log(
        result.dryRun
          ? 'Preview only. Backend selection was not changed.'
          : result.mode === 'gt-gh'
          ? 'Use gt-gh in this repository; updated pi-stack routes automatically. Do not run native gt concurrently.'
          : 'Use native gt normally; updated pi-stack routes automatically. You may uninstall gt-gh.'
      );
      console.log(
        'Commits and working files were not reset. GitHub changes were not undone.'
      );
    }
    return;
  }
  const repo = repository(cwd);
  let state = repo && readState(repo);
  if (state?.mode === 'enabling' || state?.mode === 'disabling')
    fail(
      `Switch interrupted. Retry gt-gh ${
        state.mode === 'enabling' ? 'enable' : 'disable'
      } before running stack commands.`
    );
  const nativeMode =
    state?.mode === 'graphite' || (!state && repo && fs.existsSync(repo.db));
  const separator = args.indexOf('--');
  if (
    (separator < 0 ? args : args.slice(0, separator)).includes('--capabilities')
  ) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        implementation: nativeMode ? 'graphite' : 'gt-gh',
        nativeStackSync: !nativeMode,
        repositoryScoped: true,
      })
    );
    return;
  }
  if (!nativeMode) {
    process.chdir(cwd);
    await import('./index');
    return;
  }
  // Managed native commands share the switch lock. Re-read selection after the
  // wait: another process may have enabled gt-gh while this one was queued.
  const lock = repo
    ? await StackStore.open(repo.worktree, repo.common, Infinity, {
        repositoryLock: true,
      })
    : undefined;
  try {
    state = repo && readState(repo);
    if (state?.mode === 'gt-gh') {
      lock?.close();
      process.chdir(cwd);
      await import('./index');
      return;
    }
    if (state && state.mode !== 'graphite')
      fail('Backend changed while waiting. Retry after the switch completes.');
    const native = state?.native ?? findNative();
    verifyNativeBinary(native);
    process.exitCode = await child(native.path, args, cwd);
  } finally {
    lock?.close();
  }
}
void main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
