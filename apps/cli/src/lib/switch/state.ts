import fs from 'fs';
import path from 'path';
import { atomicJSON } from '../github/stack_file';
import {
  Repository,
  RefMap,
  digest,
  fail,
  nativeDigest,
  readFile,
} from './repository';

export type NativeBinary = { path: string; version: string; digest: string };
export type CandidateBinary = { node: string; script: string };
export const ABSENT_NATIVE_DIGEST = digest('gt-gh:no-native-database');
export function nativeDatabasePresent(repo: Repository): boolean {
  try {
    fs.lstatSync(repo.db);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
export function currentNativeDigest(repo: Repository): string {
  if (nativeDatabasePresent(repo)) return nativeDigest(repo.db);
  if (fs.existsSync(repo.db + '-wal') || fs.existsSync(repo.db + '-shm'))
    fail(
      'Orphaned native SQLite sidecars found. Resolve them before switching.'
    );
  return ABSENT_NATIVE_DIGEST;
}
export type SwitchState = {
  schemaVersion: 1;
  mode: 'gt-gh' | 'graphite' | 'enabling' | 'disabling';
  session: string;
  native: NativeBinary;
  candidate: CandidateBinary;
  nativeDigest: string;
  /** Global mode adopted a repository that never had native Graphite metadata. */
  nativeAbsent?: true;
  prCache: string | null;
  repoConfig: string | null;
  /** Dormant refs at disable; native cleanup removes them independently of SQLite tracking. */
  metadataRefs?: RefMap;
};

export function readState(repo: Repository): SwitchState | undefined {
  const active = path.join(repo.control, 'state.json');
  const file = fs.existsSync(active)
    ? active
    : path.join(repo.control, 'last.json');
  if (!fs.existsSync(file)) return undefined;
  if (fs.lstatSync(file).isSymbolicLink())
    fail('Refusing a symlinked backend selection.');
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as SwitchState;
  if (
    state.schemaVersion !== 1 ||
    !['gt-gh', 'graphite', 'enabling', 'disabling'].includes(state.mode) ||
    !/^[0-9]+-[a-f0-9]{12}$/.test(state.session) ||
    !path.isAbsolute(state.native?.path ?? '') ||
    !path.isAbsolute(state.candidate?.node ?? '') ||
    !path.isAbsolute(state.candidate?.script ?? '') ||
    !/^[a-f0-9]{64}$/.test(state.nativeDigest) ||
    (state.nativeAbsent !== undefined && state.nativeAbsent !== true) ||
    (state.nativeAbsent === true && state.nativeDigest !== ABSENT_NATIVE_DIGEST)
  ) {
    fail('Unsupported or malformed gt-gh switch state. No backend was run.');
  }
  return state;
}
export function writeState(repo: Repository, state: SwitchState): void {
  fs.mkdirSync(repo.control, { recursive: true, mode: 0o700 });
  if (state.mode === 'graphite') {
    // Remove active routing: normal Graphite must keep working even if gt-gh is
    // subsequently uninstalled. Retain history only for a future re-enable.
    atomicJSON(path.join(repo.control, 'last.json'), state);
    const active = path.join(repo.control, 'state.json');
    if (fs.existsSync(active)) fs.unlinkSync(active);
  } else {
    atomicJSON(path.join(repo.control, 'state.json'), state);
  }
}
export function sessionDirectory(repo: Repository, id: string): string {
  if (!/^[0-9]+-[a-f0-9]{12}$/.test(id))
    fail('Invalid switch session identifier.');
  const sessions = path.join(repo.control, 'sessions');
  if (fs.existsSync(sessions) && fs.lstatSync(sessions).isSymbolicLink())
    fail('Refusing a symlinked switch archive.');
  const directory = path.join(sessions, id);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
    fail('Refusing a symlinked switch session.');
  return directory;
}
export function assertNativeUnchanged(
  repo: Repository,
  state: SwitchState,
  config = true
): void {
  const changed: string[] = [];
  if (currentNativeDigest(repo) !== state.nativeDigest)
    changed.push('.graphite_metadata.db (branch metadata or schema)');
  if (readFile(path.join(repo.common, '.graphite_pr_info')) !== state.prCache)
    changed.push('.graphite_pr_info');
  if (
    config &&
    readFile(path.join(repo.common, '.graphite_repo_config')) !==
      state.repoConfig
  )
    changed.push('.graphite_repo_config');
  if (changed.length) {
    fail(
      'Graphite metadata changed outside gt-gh. Stop native Graphite in every worktree. Refusing to overwrite newer work.\n' +
        `Repository: ${repo.cwd}\n` +
        changed.map((name) => `  changed ${name}`).join('\n') +
        `\nBackups: ${repo.control}\nReconcile these files before retrying; no force bypass is available.`
    );
  }
}
/** Called under the common stack lock, before loading caches or reconciling. */
export function assertCandidateEnabled(
  repo: Repository
): SwitchState | undefined {
  const state = readState(repo);
  if (!state) return undefined; // Standalone gt-gh repositories remain supported.
  if (state.mode !== 'gt-gh')
    fail(
      state.mode === 'graphite'
        ? 'This repository is using Graphite. Use gt from PATH, or run enable.sh to switch back.'
        : `Backend switch is incomplete. Retry ${
            state.mode === 'enabling' ? 'enable.sh' : 'disable.sh'
          }; no stack operation was run.`
    );
  assertNativeUnchanged(repo, state);
  return state;
}
/** Candidate-owned config changes (including undo) become the next CAS baseline. */
export function recordCandidateConfig(
  repo: Repository,
  state: SwitchState | undefined
): void {
  if (!state) return;
  assertNativeUnchanged(repo, state, false);
  const repoConfig = readFile(path.join(repo.common, '.graphite_repo_config'));
  if (repoConfig !== state.repoConfig)
    writeState(repo, { ...state, repoConfig });
}
export function verifyNativeBinary(binary: NativeBinary): void {
  if (
    !fs.existsSync(binary.path) ||
    digest(fs.readFileSync(binary.path)) !== binary.digest
  ) {
    fail(
      'The saved Graphite binary changed or disappeared. Reinstall the verified Graphite version before switching; no fallback binary was guessed.'
    );
  }
}
