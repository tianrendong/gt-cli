import fs from 'fs';
import { assertBundledSqliteRuntime } from './sqlite';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { atomicJSON, StackStore } from '../github/stack_file';
import { BindingLock } from './binding_lock';
import { resumeExistingClone } from './resume';
import {
  Repository,
  RepoSnapshot,
  MANAGED_FILES,
  backupDatabase,
  equal,
  fail,
  nativeDigest,
  nativeRows,
  validateNativeSchema,
  encodedJSON,
  NATIVE_COLUMNS,
  sqlite,
  sqlString,
} from './repository';
import {
  SwitchState,
  CandidateBinary,
  readState,
  writeState,
  sessionDirectory,
  assertNativeUnchanged,
  verifyNativeBinary,
  ABSENT_NATIVE_DIGEST,
  currentNativeDigest,
  nativeDatabasePresent,
} from './state';
import {
  assertNoNativeProcess,
  commitNativeRows,
  createNativeDatabase,
  findNative,
  verifyWithNative,
} from './native';
import {
  assertReenableMetadata,
  currentTopology,
  metadataRefs,
  nativePrCache,
  nativeRepoConfig,
  planImport,
} from './plan';

export type SwitchOptions = {
  repo: string;
  candidate: CandidateBinary;
  graphite?: string;
  restoreMissingParents?: boolean;
  dryRun?: boolean;
  /** Management toggles must not wait for repository commands. An existing
   * clone can resume routing while its runtime update remains deferred. */
  nonBlocking?: boolean;
};
type Transition = {
  schemaVersion: 1;
  kind: 'enable' | 'disable';
  before: RepoSnapshot;
  after: RepoSnapshot;
  beforeNativeDigest: string;
  beforeNativeAbsent?: true;
  afterNativeDigest: string;
  previous?: SwitchState;
  final: SwitchState;
  blobs: Record<string, string>;
  restored: string[];
};
export type SwitchResult = {
  mode: string;
  dryRun?: boolean;
  already?: boolean;
  backup?: string;
  branches?: number;
  restored?: string[];
  selectionOnly?: boolean;
  candidate?: CandidateBinary;
  bindingDeferred?: boolean;
  /** Do not let an older dispatcher retry a blocker it may not understand. */
  bindingBlocked?: boolean;
  warnings?: string[];
};

async function waitForNative(repo: Repository): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      assertNoNativeProcess(repo);
      return;
    } catch (error) {
      if (
        !error.message.includes('Native Graphite is still running') ||
        Date.now() >= deadline
      )
        throw error;
      await sleep(100);
    }
  }
}

function validateTransition(value: Transition): void {
  const changedHeads = [
    ...new Set([
      ...Object.keys(value.before.refs),
      ...Object.keys(value.after.refs),
    ]),
  ].filter(
    (ref) =>
      ref.startsWith('refs/heads/') &&
      value.before.refs[ref] !== value.after.refs[ref]
  );
  const allowed =
    value.kind === 'enable'
      ? value.restored.map((branch) => `refs/heads/${branch}`)
      : [];
  if (
    !equal(changedHeads.sort(), allowed.sort()) ||
    changedHeads.some(
      (ref) => value.before.refs[ref] !== undefined || !value.after.refs[ref]
    )
  ) {
    fail(
      'Unsafe switch manifest: existing branch tips must never be changed or removed.'
    );
  }
  for (const files of [value.before.files, value.after.files]) {
    if (
      !equal(Object.keys(files).sort(), [...MANAGED_FILES].sort()) ||
      Object.values(files).some((v) => v !== null && typeof v !== 'string')
    )
      fail('Unsafe file list in switch manifest.');
  }
  if (
    value.before.worktrees !== value.after.worktrees ||
    value.final.nativeDigest !== value.afterNativeDigest ||
    (value.kind === 'enable' &&
      value.beforeNativeDigest !== value.afterNativeDigest) ||
    (value.beforeNativeAbsent !== undefined &&
      value.beforeNativeAbsent !== true) ||
    (value.beforeNativeAbsent &&
      (value.kind !== 'disable' ||
        value.beforeNativeDigest !== ABSENT_NATIVE_DIGEST ||
        !value.previous?.nativeAbsent))
  )
    fail('Invalid switch metadata invariant.');
}

function assertSnapshot(repo: Repository, expected: RepoSnapshot): void {
  if (!equal(repo.snapshot(), expected))
    fail(
      'Repository metadata, refs, or worktree registrations changed during preflight. Stop other writers and retry. Nothing was reset.'
    );
}
function saveTransition(
  repo: Repository,
  transition: Transition,
  temporary: string
): string {
  validateTransition(transition);
  const directory = sessionDirectory(repo, transition.final.session);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!transition.beforeNativeAbsent)
    backupDatabase(
      path.join(temporary, 'before.sqlite'),
      path.join(directory, 'before.sqlite')
    );
  if (transition.kind === 'disable')
    backupDatabase(
      path.join(temporary, 'native-check/.git/.graphite_metadata.db'),
      path.join(directory, 'target.sqlite')
    );
  fs.copyFileSync(
    path.join(temporary, 'native-validation.log'),
    path.join(directory, 'native-validation.log')
  );
  atomicJSON(path.join(directory, 'transition.json'), transition);
  // Keep backup objects reachable. Never delete another session's refs or locks.
  const anchors = Object.entries(transition.before.refs).map(
    ([ref, sha]) =>
      `create refs/gt-switch/${transition.final.session}/${ref} ${sha}`
  );
  repo.git(
    ['update-ref', '--stdin'],
    ['start', ...anchors, 'prepare', 'commit', ''].join('\n')
  );
  writeState(repo, {
    ...transition.final,
    mode: transition.kind === 'enable' ? 'enabling' : 'disabling',
    nativeDigest: transition.beforeNativeDigest,
    ...(transition.beforeNativeAbsent ? { nativeAbsent: true as const } : {}),
    prCache: transition.before.files['.graphite_pr_info'],
    repoConfig: transition.before.files['.graphite_repo_config'],
  });
  return directory;
}
function loadTransition(repo: Repository, state: SwitchState): Transition {
  const value = JSON.parse(
    fs.readFileSync(
      path.join(sessionDirectory(repo, state.session), 'transition.json'),
      'utf8'
    )
  ) as Transition;
  if (
    value.schemaVersion !== 1 ||
    !['enable', 'disable'].includes(value.kind) ||
    value.final.session !== state.session ||
    !equal(value.final.native, state.native) ||
    !value.before?.refs ||
    !value.after?.refs
  )
    fail('Invalid switch recovery manifest.');
  validateTransition(value);
  return value;
}
function assertFilesRecoverable(
  repo: Repository,
  transition: Transition
): void {
  const current = repo.files();
  for (const name of MANAGED_FILES) {
    if (
      current[name] !== transition.before.files[name] &&
      current[name] !== transition.after.files[name]
    )
      fail(
        `${name} changed outside the interrupted switch. Nothing was overwritten.`
      );
  }
  if (
    repo.git(['worktree', 'list', '--porcelain']) !==
    transition.before.worktrees
  )
    fail(
      'Worktree registrations changed during the switch. Nothing was reset.'
    );
}
function completeTransition(
  repo: Repository,
  transition: Transition
): SwitchResult {
  const directory = sessionDirectory(repo, transition.final.session);
  verifyNativeBinary(transition.final.native);
  repo.assertIdle();
  assertNoNativeProcess(repo);
  assertFilesRecoverable(repo, transition);
  const actualNative = currentNativeDigest(repo);
  if (
    actualNative !== transition.beforeNativeDigest &&
    actualNative !== transition.afterNativeDigest
  )
    fail(
      'Graphite database changed outside the interrupted switch. Refusing to overwrite it.'
    );
  if (transition.kind === 'enable') {
    const refs = repo.refs();
    if (!equal(refs, transition.after.refs)) {
      repo.assertRefs(transition.before.refs);
      for (const [ref, content] of Object.entries(transition.blobs)) {
        if (!ref.startsWith('refs/branch-metadata/'))
          fail('Invalid metadata blob in switch manifest.');
        if (
          repo.git(['hash-object', '-w', '--stdin'], content) !==
          transition.after.refs[ref]
        )
          fail('Switch metadata blob checksum mismatch.');
      }
      repo.applyRefs(transition.before.refs, transition.after.refs);
    }
  } else {
    repo.assertRefs(transition.before.refs);
    if (actualNative !== transition.afterNativeDigest) {
      const beforeDb = path.join(directory, 'before.sqlite');
      const targetDb = path.join(directory, 'target.sqlite');
      if (transition.beforeNativeAbsent) {
        if (nativeDigest(targetDb) !== transition.afterNativeDigest)
          fail(
            'Switch database backup checksum mismatch. No native database was created.'
          );
        createNativeDatabase(repo, targetDb);
      } else {
        if (
          nativeDigest(beforeDb) !== transition.beforeNativeDigest ||
          nativeDigest(repo.db, nativeRows(targetDb)) !==
            transition.afterNativeDigest
        )
          fail(
            'Switch database backup checksum mismatch. Live Graphite data was not overwritten.'
          );
        commitNativeRows(repo, beforeDb, targetDb);
      }
    }
    if (nativeDigest(repo.db) !== transition.afterNativeDigest)
      fail(
        'Graphite handoff verification failed. Retry disable.sh; backup retained.'
      );
  }
  for (const name of MANAGED_FILES)
    repo.applyFile(
      name,
      transition.before.files[name],
      transition.after.files[name]
    );
  assertSnapshot(repo, transition.after);
  if (nativeDigest(repo.db) !== transition.afterNativeDigest)
    fail(
      'Graphite changed during handoff. Switch remains paused; no commits were reset.'
    );
  writeState(repo, transition.final);
  return {
    mode: transition.final.mode,
    backup: directory,
    restored: transition.restored,
  };
}
function cancelEnable(repo: Repository, transition: Transition): SwitchResult {
  repo.assertIdle();
  assertNoNativeProcess(repo);
  assertFilesRecoverable(repo, transition);
  if (nativeDigest(repo.db) !== transition.beforeNativeDigest)
    fail(
      'Graphite changed during interrupted enable. Refusing to restore stale metadata.'
    );
  if (!equal(repo.refs(), transition.before.refs))
    repo.applyRefs(transition.after.refs, transition.before.refs);
  for (const name of MANAGED_FILES)
    repo.applyFile(
      name,
      transition.after.files[name],
      transition.before.files[name]
    );
  assertSnapshot(repo, transition.before);
  if (transition.previous) writeState(repo, transition.previous);
  else fs.unlinkSync(path.join(repo.control, 'state.json'));
  return {
    mode: 'graphite',
    backup: sessionDirectory(repo, transition.final.session),
  };
}

// eslint-disable-next-line max-lines-per-function
export async function switchBackend(
  kind: 'enable' | 'disable',
  options: SwitchOptions
): Promise<SwitchResult> {
  assertBundledSqliteRuntime();
  const repo = new Repository(options.repo);
  if (
    kind === 'enable' &&
    options.nonBlocking &&
    readState(repo)?.mode === 'gt-gh'
  )
    return resumeExistingClone(repo, options);
  repo.assertIdle();
  // Running commands hold shared binding leases. Management toggles must fail
  // promptly if an actual metadata migration cannot acquire exclusive access.
  const nonBlocking = kind === 'disable' || options.nonBlocking;
  const lease = await BindingLock.exclusive(
    repo.common,
    nonBlocking ? 0 : 30_000
  );
  let store: StackStore;
  try {
    store = await StackStore.open(
      repo.worktree,
      repo.common,
      nonBlocking ? 0 : Infinity,
      { repositoryLock: true }
    );
  } catch (error) {
    lease.close();
    throw error;
  }
  let temporary: string | undefined;
  try {
    const previous = readState(repo);
    if (previous?.mode === 'enabling' || previous?.mode === 'disabling') {
      const transition = loadTransition(repo, previous);
      if (options.dryRun)
        return {
          mode: previous.mode,
          dryRun: true,
          backup: sessionDirectory(repo, previous.session),
        };
      if (kind === 'disable' && transition.kind === 'enable')
        return cancelEnable(repo, transition);
      if (kind !== transition.kind)
        fail(
          `Finish the interrupted ${transition.kind} first by rerunning ${transition.kind}.sh.`
        );
      return completeTransition(repo, transition);
    }
    if (
      kind === 'enable' &&
      previous?.mode === 'graphite' &&
      previous.nativeAbsent &&
      currentNativeDigest(repo) === ABSENT_NATIVE_DIGEST
    ) {
      assertReenableMetadata(repo, repo.refs(), {
        expected: previous.metadataRefs ?? {},
      });
      verifyNativeBinary(previous.native);
      const files = repo.files();
      if (!options.dryRun)
        writeState(repo, {
          ...previous,
          mode: 'gt-gh',
          candidate: options.candidate,
          prCache: files['.graphite_pr_info'],
          repoConfig: files['.graphite_repo_config'],
        });
      return {
        mode: 'gt-gh',
        branches: 0,
        ...(options.dryRun ? { dryRun: true } : {}),
      };
    }
    if (kind === 'disable' && !previous) {
      const refs = metadataRefs(repo.refs());
      const absent = !nativeDatabasePresent(repo);
      if (absent && Object.keys(refs).length)
        fail(
          'No managed Graphite trial to disable. Standalone gt-gh data was left untouched.'
        );
      const native = findNative(options.graphite),
        files = repo.files();
      const nativeDigest = currentNativeDigest(repo);
      if (!options.dryRun)
        writeState(repo, {
          schemaVersion: 1,
          mode: 'graphite',
          session: `${Date.now()}-${randomBytes(6).toString('hex')}`,
          native,
          candidate: options.candidate,
          nativeDigest,
          ...(absent ? { nativeAbsent: true as const } : {}),
          prCache: files['.graphite_pr_info'],
          repoConfig: files['.graphite_repo_config'],
          metadataRefs: refs,
        });
      return {
        mode: 'graphite',
        already: true,
        ...(options.dryRun ? { dryRun: true } : {}),
      };
    }
    if (kind === 'disable' && previous?.mode === 'graphite')
      return {
        mode: 'graphite',
        already: true,
        ...(options.dryRun ? { dryRun: true } : {}),
      };
    if (kind === 'enable' && previous?.mode === 'gt-gh') {
      assertNativeUnchanged(repo, previous);
      if (!options.dryRun && !equal(previous.candidate, options.candidate))
        writeState(repo, { ...previous, candidate: options.candidate });
      return {
        mode: 'gt-gh',
        already: true,
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(previous.nativeAbsent
          ? {}
          : { backup: sessionDirectory(repo, previous.session) }),
      };
    }
    if (kind === 'enable' && !previous && !nativeDatabasePresent(repo)) {
      assertNoNativeProcess(repo);
      if (currentNativeDigest(repo) !== ABSENT_NATIVE_DIGEST)
        fail(
          'Native metadata appeared during enable. Retry without changing it.'
        );
      const native = findNative(options.graphite);
      const files = repo.files();
      if (!options.dryRun)
        writeState(repo, {
          schemaVersion: 1,
          mode: 'gt-gh',
          session: `${Date.now()}-${randomBytes(6).toString('hex')}`,
          native,
          candidate: options.candidate,
          nativeDigest: ABSENT_NATIVE_DIGEST,
          nativeAbsent: true,
          prCache: files['.graphite_pr_info'],
          repoConfig: files['.graphite_repo_config'],
        });
      return {
        mode: 'gt-gh',
        branches: Object.keys(metadataRefs(repo.refs())).length,
        ...(options.dryRun ? { dryRun: true } : {}),
      };
    }
    await waitForNative(repo);
    const standalone = kind === 'disable' && previous?.nativeAbsent === true;
    if (standalone) {
      assertNativeUnchanged(repo, previous!);
      const refs = repo.refs();
      const empty = !Object.keys(refs).some(
        (ref) =>
          ref.startsWith('refs/heads/') ||
          ref.startsWith('refs/branch-metadata/')
      );
      if (!repo.files()['.graphite_repo_config'] || empty) {
        if (Object.keys(metadataRefs(repo.refs())).length)
          fail(
            'Standalone stack has no trunk configuration. Initialize it with gt init before handing it back.'
          );
        if (!options.dryRun)
          writeState(repo, {
            ...previous!,
            mode: 'graphite',
            metadataRefs: {},
          });
        return {
          mode: 'graphite',
          branches: 0,
          ...(options.dryRun ? { dryRun: true } : {}),
        };
      }
    } else {
      if (!nativeDatabasePresent(repo))
        fail(
          'No Graphite SQLite database found. Initialize Graphite before using reversible enable.'
        );
      validateNativeSchema(repo.db);
    }
    const native = options.graphite
      ? findNative(options.graphite)
      : kind === 'disable' && previous
      ? previous.native
      : findNative();
    verifyNativeBinary(native);
    if (kind === 'disable' && previous) assertNativeUnchanged(repo, previous);
    const before = repo.snapshot();
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-gh-handoff-'));
    if (!standalone)
      backupDatabase(repo.db, path.join(temporary, 'before.sqlite'));
    const beforeNativeDigest = standalone
      ? ABSENT_NATIVE_DIGEST
      : nativeDigest(path.join(temporary, 'before.sqlite'));
    if (currentNativeDigest(repo) !== beforeNativeDigest)
      fail(
        'Graphite changed during backup. Retry after pausing native commands.'
      );
    assertSnapshot(repo, before);
    const rows =
      kind === 'enable'
        ? nativeRows(path.join(temporary, 'before.sqlite'))
        : undefined;
    if (kind === 'enable' && previous)
      assertReenableMetadata(repo, before.refs, {
        expected: previous.metadataRefs ?? {},
        rows,
      });
    const imported =
      kind === 'enable'
        ? planImport(repo, before, {
            rows: rows!,
            restore: options.restoreMissingParents === true,
            replacing: Boolean(previous),
          })
        : undefined;
    const topology = imported?.topology ?? currentTopology(repo, before);
    const checked = verifyWithNative(repo, {
      native,
      topology,
      directory: temporary,
    });
    if (kind === 'disable' && previous && !standalone) {
      // Preserve native-only history for branches already absent at enable.
      // Only branches that existed during this trial may have been deliberately
      // deleted/untracked by gt-gh; do not sweep unrelated historical rows.
      const entered = loadTransition(repo, previous);
      const initiallyLive = new Set(
        Object.keys(entered.after.refs)
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice(11))
      );
      const historical = nativeRows(
        path.join(temporary, 'before.sqlite')
      ).filter(
        (row) =>
          !initiallyLive.has(row.branch_name) &&
          !topology.heads[row.branch_name]
      );
      if (historical.length) {
        const columns = NATIVE_COLUMNS.join(',');
        sqlite(
          checked.db,
          `ATTACH DATABASE ${sqlString(
            path.join(temporary, 'before.sqlite')
          )} AS original;
          INSERT INTO main.branch_metadata (${columns}) SELECT ${columns} FROM original.branch_metadata
          WHERE branch_name IN (${historical
            .map((row) => sqlString(row.branch_name))
            .join(',')});`,
          false
        );
        checked.rows = nativeRows(checked.db);
      }
    }
    const after: RepoSnapshot = imported?.after ?? {
      ...before,
      files: {
        ...before.files,
        '.graphite_repo_config': encodedJSON(nativeRepoConfig(topology)),
        '.graphite_pr_info': nativePrCache(
          topology,
          before.files['.graphite_pr_info']
        ),
      },
    };
    assertSnapshot(repo, before);
    if (currentNativeDigest(repo) !== beforeNativeDigest)
      fail('Graphite changed during validation. Nothing was migrated.');
    if (options.dryRun)
      return {
        mode: kind === 'enable' ? 'gt-gh' : 'graphite',
        dryRun: true,
        branches: Object.keys(topology.metadata).length,
        restored: imported?.restored ?? [],
      };
    const session = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const afterNativeDigest =
      kind === 'enable'
        ? beforeNativeDigest
        : standalone
        ? nativeDigest(checked.db)
        : nativeDigest(repo.db, checked.rows);
    const final: SwitchState = {
      schemaVersion: 1,
      mode: kind === 'enable' ? 'gt-gh' : 'graphite',
      session,
      native,
      candidate: options.candidate,
      nativeDigest: afterNativeDigest,
      prCache: after.files['.graphite_pr_info'],
      repoConfig: after.files['.graphite_repo_config'],
      ...(kind === 'disable' ? { metadataRefs: metadataRefs(after.refs) } : {}),
    };
    const transition: Transition = {
      schemaVersion: 1,
      kind,
      before,
      after,
      beforeNativeDigest,
      ...(standalone ? { beforeNativeAbsent: true as const } : {}),
      afterNativeDigest,
      previous,
      final,
      blobs: imported?.blobs ?? {},
      restored: imported?.restored ?? [],
    };
    saveTransition(repo, transition, temporary);
    return {
      ...completeTransition(repo, transition),
      branches: Object.keys(topology.metadata).length,
    };
  } finally {
    store.close();
    lease.close();
    if (temporary) {
      try {
        fs.rmSync(temporary, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        process.stderr.write(
          `WARNING: Could not remove validation files at ${temporary}. Backend result is unchanged; remove this isolated directory after its helpers exit.\n`
        );
      }
    }
  }
}
