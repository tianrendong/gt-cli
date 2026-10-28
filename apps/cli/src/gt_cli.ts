#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getGitPaths } from './lib/git/git_dir';
import {
  inspectLauncher,
  marker as nativeMarker,
  nativeBinary,
} from '../scripts/installation/native_escape.cjs';
import { StackStore } from './lib/github/stack_file';
import { Repository, fail } from './lib/switch/repository';
import { findNative } from './lib/switch/native';
import {
  readState,
  SwitchState,
  verifyNativeBinary,
  nativeDatabasePresent,
} from './lib/switch/state';
import { adoptGlobalRepository } from './lib/switch/global';
import { launcherFromEnvironment } from './lib/switch/launcher';
import { BindingLock } from './lib/switch/binding_lock';
import { catchUpBinding } from './lib/switch/binding_update';
import { implementationFor } from './lib/switch/selection';
import { startUpdateNotification } from './lib/updates/notifier';
import {
  repositoryInitialized,
  initializationRequested,
} from './lib/switch/initialization';

const args = process.argv.slice(2);
const options = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
function cwdFromArgs(): string {
  const at = options.indexOf('--cwd');
  const value =
    options.find((arg) => arg.startsWith('--cwd='))?.slice(6) ??
    (at < 0 ? undefined : options[at + 1]);
  if (at >= 0 && (!value || value.startsWith('--')))
    fail('Missing value for --cwd.');
  return path.resolve(value ?? process.cwd());
}
function repository(cwd: string): Repository | undefined {
  const paths = getGitPaths(cwd);
  return paths ? new Repository(cwd, paths) : undefined;
}
function checkTransition(state: SwitchState | undefined): void {
  if (state?.mode === 'enabling' || state?.mode === 'disabling')
    fail(
      `Backend switch is incomplete. Rerun ${
        state.mode === 'enabling' ? 'enable.sh' : 'disable.sh'
      } before using gt.`
    );
}
function child(
  file: string,
  argv: string[],
  options: { cwd: string; lease?: BindingLock }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(file, argv, {
      cwd: options.cwd,
      // Inherit the lease too: an orphaned child stays protected if its
      // dispatcher is killed. Old releases need no special FD handling.
      stdio: options.lease
        ? ['inherit', 'inherit', 'inherit', options.lease.descriptor]
        : 'inherit',
    });
    childProcess.once('error', reject);
    childProcess.once('close', (code) => resolve(code ?? 1));
  });
}
async function candidate(
  cwd: string,
  state?: SwitchState,
  lease?: BindingLock
): Promise<void> {
  const notify = startUpdateNotification(
    path.resolve(__dirname, '../..'),
    args
  );
  const selected = state?.candidate;
  const localEntry = path.join(__dirname, 'index.js');
  let sameRelease = !selected;
  if (selected) {
    try {
      sameRelease =
        fs.realpathSync(selected.node) === fs.realpathSync(process.execPath) &&
        fs.realpathSync(selected.script) === fs.realpathSync(localEntry);
    } catch {
      // Keep the existing child-process error behavior for missing binaries or
      // scripts; never guess a replacement for a pinned release.
    }
  }
  if (sameRelease) {
    process.chdir(cwd);
    process.argv[1] = selected?.script ?? localEntry;
    await (
      await import('./index')
    ).completion;
  } else if (selected) {
    // Older/different releases retain their own process and inherited lease.
    process.exitCode = await child(selected.node, [selected.script, ...args], {
      cwd,
      lease,
    });
  }
  notify?.(process.exitCode ?? 0);
}
async function managedCandidate(cwd: string, repo: Repository): Promise<void> {
  await catchUpBinding(repo);
  const lease = await BindingLock.shared(repo.common);
  try {
    // Re-read after taking the lease; an updater may have won just before us.
    const state = readState(repo);
    checkTransition(state);
    if (!state || state.mode !== 'gt-gh') {
      lease.close();
      return await main();
    }
    await candidate(cwd, state, lease);
  } finally {
    lease.close();
  }
}
async function nativeEscape(cwd: string): Promise<void> {
  if (options.includes('--capabilities')) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        implementation: 'graphite',
        nativeStackSync: false,
      })
    );
  } else {
    const native = nativeBinary(inspectLauncher(undefined));
    process.exitCode = await child(native.path, args, { cwd });
  }
}
async function main(): Promise<void> {
  if (process.env.GT_GH_PROBING_NATIVE)
    fail('This gt entry is the dispatcher, not native Graphite.');
  const cwd = cwdFromArgs();
  const paths = getGitPaths(cwd);
  const common = paths
    ? fs.realpathSync(path.resolve(cwd, paths.commonDir))
    : undefined;
  const escaped = Boolean(common && fs.existsSync(nativeMarker(common)));
  let launcher = escaped ? undefined : launcherFromEnvironment();
  // Explicit native selection outranks stale, malformed, or interrupted clone
  // state. Do not take clone locks or require its saved binary digest to match.
  if (
    escaped ||
    (common && launcher?.implementations?.[common]?.mode === 'graphite')
  )
    return nativeEscape(cwd);
  const repo = repository(cwd);
  let state = repo ? readState(repo) : undefined;
  checkTransition(state);
  const selectNative = (): boolean =>
    state?.mode === 'graphite' ||
    (!state &&
      implementationFor(launcher, repo?.common) !== 'gt-gh' &&
      Boolean(launcher || (repo && nativeDatabasePresent(repo))));
  let nativeMode = selectNative();
  if (options.includes('--capabilities')) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        implementation: nativeMode ? 'graphite' : 'gt-gh',
        nativeStackSync: !nativeMode,
        ...(!state &&
        implementationFor(launcher, repo?.common) === 'gt-gh' &&
        repo &&
        nativeDatabasePresent(repo)
          ? { migrationRequired: true }
          : {}),
      })
    );
    return;
  }
  const commandOptions = options.filter(
    (arg, index) =>
      arg !== '--cwd' &&
      !arg.startsWith('--cwd=') &&
      options[index - 1] !== '--cwd'
  );
  const informationOnly = commandOptions.some((arg) =>
    ['--version', '--help', '-h'].includes(arg)
  );
  const initialize =
    !informationOnly && initializationRequested(commandOptions);
  if (
    !nativeMode &&
    !state &&
    repo &&
    implementationFor(launcher, repo.common) === 'gt-gh' &&
    !informationOnly &&
    (initialize || repositoryInitialized(repo))
  ) {
    await adoptGlobalRepository(
      repo,
      {
        node: process.execPath,
        script: fs.realpathSync(path.join(__dirname, 'index.js')),
      },
      initialize
    );
    // Selection may have changed while waiting for the installer/repository lock.
    launcher = launcherFromEnvironment();
    state = readState(repo);
    checkTransition(state);
    nativeMode = selectNative();
  }
  if (!nativeMode)
    return repo && state?.mode === 'gt-gh'
      ? managedCandidate(cwd, repo)
      : candidate(cwd, state);
  // Every gt consumer (including unchanged pi-stack) participates through this
  // PATH entry. Re-read repository selection after obtaining the common lock.
  const pureInformation =
    informationOnly &&
    commandOptions.every((arg) =>
      ['--version', '--help', '-h', '--no-interactive'].includes(arg)
    );
  const lock =
    repo && !pureInformation
      ? await StackStore.open(repo.worktree, repo.common, Infinity, {
          repositoryLock: true,
        })
      : undefined;
  try {
    state = repo ? readState(repo) : undefined;
    checkTransition(state);
    launcher = launcherFromEnvironment();
    if (!state && implementationFor(launcher, repo?.common) === 'gt-gh') {
      lock?.close();
      return await main();
    }
    if (state?.mode === 'gt-gh') {
      lock?.close();
      return repo
        ? await managedCandidate(cwd, repo)
        : await candidate(cwd, state);
    }
    const native = launcher?.native ?? state?.native ?? findNative();
    verifyNativeBinary(native);
    process.exitCode = await child(native.path, args, { cwd });
  } finally {
    lock?.close();
  }
}
void main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
