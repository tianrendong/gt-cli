import { rebaseInProgress } from './rebase_in_progress';
import { runGitCommand } from './runner';

/**
 * Stage tracked modifications (like `git add -u`), without adding untracked
 * files. Used by `gt absorb --all`.
 */
export function addUpdate(): void {
  runGitCommand({
    args: ['add', '--update'],
    onError: 'throw',
    resource: 'absorbAddUpdate',
  });
}

/**
 * Return the staged diff (index vs HEAD) with full headers, including the
 * `index <blob>..<blob>` lines required for three-way application.
 */
export function getStagedDiff(): string {
  return runGitCommand({
    // Zero context (-U0) so each contiguous changed region is its own hunk,
    // allowing per-region routing to the commit that last touched those lines.
    args: [
      '--no-pager',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '-U0',
      '--cached',
    ],
    options: { noTrim: true },
    onError: 'throw',
    resource: 'absorbStagedDiff',
  });
}

/**
 * Blame a line range of a file at a given revision, returning the commit SHA
 * for each line in the range (in order). Lines that come from uncommitted or
 * boundary content are returned as-is (caller filters by candidate set).
 */
export function blameLines(args: {
  rev: string;
  file: string;
  startLine: number;
  endLine: number;
}): string[] {
  const output = runGitCommand({
    args: [
      '--no-pager',
      'blame',
      '--porcelain',
      '-L',
      `${args.startLine},${args.endLine}`,
      args.rev,
      '--',
      args.file,
    ],
    options: { noTrim: true },
    onError: 'ignore',
    resource: 'absorbBlame',
  });

  const shas: string[] = [];
  for (const line of output.split('\n')) {
    // Porcelain header lines for a blamed line start with a 40-char SHA
    // followed by line numbers.
    const match = line.match(/^([0-9a-f]{40}) \d+ \d+/);
    if (match) {
      shas.push(match[1]);
    }
  }
  return shas;
}

/**
 * Apply a patch to the index using a three-way merge so it tolerates context
 * drift between the working-tree diff and the historical branch tip. Returns
 * true on success, false if the patch could not be applied.
 */
export function applyPatchToIndexThreeWay(patch: string): boolean {
  try {
    runGitCommand({
      args: [
        'apply',
        '--3way',
        '--unidiff-zero',
        '--index',
        '--whitespace=nowarn',
        '-',
      ],
      options: { input: patch },
      onError: 'throw',
      resource: 'absorbApply',
    });
    return true;
  } catch {
    // Clean up any partial three-way state.
    runGitCommand({
      args: ['reset', '--quiet'],
      onError: 'ignore',
      resource: 'absorbApplyReset',
    });
    return false;
  }
}

/**
 * Apply a patch to the working tree (not the index) using a three-way merge.
 * Used to restore un-absorbable changes after the absorb surgery. Returns true
 * on success.
 */
export function applyPatchToWorktreeThreeWay(patch: string): boolean {
  try {
    runGitCommand({
      args: ['apply', '--3way', '--unidiff-zero', '--whitespace=nowarn', '-'],
      options: { input: patch },
      onError: 'throw',
      resource: 'absorbRestore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a `fixup!` commit targeting a commit with the given subject. During an
 * autosquash rebase this folds into the matching commit.
 */
export function commitFixup(subject: string): void {
  runGitCommand({
    args: ['commit', '--no-verify', '-m', `fixup! ${subject}`],
    options: { stdio: 'pipe' },
    onError: 'throw',
    resource: 'absorbCommitFixup',
  });
}

/**
 * Run a non-interactive autosquash rebase onto `onto`, folding any `fixup!`
 * commits into their targets. Returns 'REBASE_CONFLICT' if it stops on a
 * conflict, otherwise 'REBASE_DONE'.
 */
export function autosquashRebase(
  onto: string
): 'REBASE_CONFLICT' | 'REBASE_DONE' {
  try {
    runGitCommand({
      args: ['rebase', '-i', '--autosquash', onto],
      options: {
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_SEQUENCE_EDITOR: 'true',
          GIT_EDITOR: 'true',
        },
      },
      onError: 'throw',
      resource: 'absorbAutosquash',
    });
  } catch (e) {
    if (rebaseInProgress()) {
      return 'REBASE_CONFLICT';
    }
    throw e;
  }
  return 'REBASE_DONE';
}
