import fs from 'fs';
import path from 'path';
import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { ExitFailedError } from '../lib/errors';
import { journalGit as git } from '../lib/operations/journal';
import { worktreeGitDirectory } from '../lib/github/stack_file';
import { assertBranchesAvailable } from '../lib/git/worktrees';
import { prepareRewrittenCommits } from './modify_into';
import { restackBranches } from './restack';

export type AbsorbHunk = {
  header: string;
  body: string[];
  branch?: string;
  commit?: string;
  commitLabel?: string;
};
export type AbsorbPlan = {
  branches: { branch: string; commits: Map<string, string> }[];
  /** Hunks left staged. `hidden` entries (binary and new files) are kept for
   * re-staging but, like native gt, are neither displayed nor counted. */
  unassigned: { reason: string; patch: string; hidden?: boolean }[];
  hunks: { branch: string; commit: string; file: string; line: number }[];
  /** Display order: staged files, each with its zero-context hunks. */
  files: { file: string; hunks: AbsorbHunk[] }[];
};

/** Assign staged text hunks to the specific commits that last touched their
 * changed lines. Ambiguous, trunk-owned, new-file, and binary hunks are never
 * guessed; they stay staged rather than being silently absorbed.
 */
// eslint-disable-next-line max-lines-per-function
export function planAbsorb(context: TContext): AbsorbPlan {
  const current = context.engine.currentBranchPrecondition;
  const branches = context.engine.getRelativeStack(current, SCOPE.DOWNSTACK);
  const owners = new Map<string, string>();
  branches.forEach((branch) =>
    context.engine
      .getAllCommits(branch, 'SHA')
      .forEach((sha) => owners.set(sha, branch))
  );
  const files = git(['diff', '--cached', '--name-only', '--no-renames', '-z'], {
    noTrim: true,
  })
    .split('\0')
    .filter(Boolean);
  const plan: AbsorbPlan = {
    branches: [],
    unassigned: [],
    hunks: [],
    files: [],
  };
  const patches = new Map<string, string[]>();
  for (const file of files) {
    const patch = git(
      [
        'diff',
        '--cached',
        '--binary',
        '--no-ext-diff',
        '--no-renames',
        '--no-color',
        // Zero context, like native gt: adjacent edits owned by different
        // commits stay separate hunks instead of becoming one ambiguous one.
        '-U0',
        '--',
        file,
      ],
      { noTrim: true }
    );
    const starts = [
      ...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm),
    ];
    if (!starts.length) {
      plan.unassigned.push({
        reason: `${file}: binary or mode-only change`,
        patch,
        hidden: true,
      });
      continue;
    }
    const header = patch.slice(0, starts[0].index);
    if (header.includes('--- /dev/null')) {
      // Matches gt: file creations are never absorbed into older commits.
      plan.unassigned.push({
        reason: `${file}: new file`,
        patch,
        hidden: true,
      });
      continue;
    }
    const display: AbsorbHunk[] = [];
    plan.files.push({ file, hunks: display });
    const blame = new Map<number, string>();
    const output = git(['blame', '--line-porcelain', 'HEAD', '--', file]);
    for (const match of output.matchAll(
      /^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/gm
    )) {
      blame.set(Number(match[2]), match[1]);
    }
    starts.forEach((start, index) => {
      const hunk = patch.slice(
        start.index,
        starts[index + 1]?.index ?? patch.length
      );
      const lines = changedLines(hunk, Number(start[1]));
      const commits = new Set(lines.map((line) => blame.get(line) || ''));
      const commit = commits.size === 1 ? [...commits][0] : undefined;
      const branch = commit ? owners.get(commit) : undefined;
      const body = hunk
        .split('\n')
        .slice(1)
        .filter((line) => line.length && !line.startsWith('\\'));
      // Native always prints explicit counts, unlike Git's -U0 shorthand.
      const hunkHeader = `@@ -${start[1]},${start[2] ?? 1} +${start[3]},${
        start[4] ?? 1
      } @@`;
      if (!commit || !branch || context.engine.isTrunk(branch)) {
        display.push({ header: hunkHeader, body });
        plan.unassigned.push({
          reason: `${file}:${start[1]}: ambiguous or trunk-owned hunk`,
          patch: header + hunk,
        });
        return;
      }
      display.push({
        header: hunkHeader,
        body,
        branch,
        commit,
        commitLabel: git(['log', '-1', '--format=%h - %s', commit]),
      });
      const group = patches.get(commit) ?? [];
      // A separate copy of the header per commit keeps each patch applyable.
      if (!group.length || !group[group.length - 1].startsWith(header)) {
        group.push(header + hunk);
      } else {
        group[group.length - 1] += hunk;
      }
      patches.set(commit, group);
      plan.hunks.push({ branch, commit, file, line: Number(start[1]) });
    });
  }
  plan.branches = branches
    .filter((branch) =>
      context.engine
        .getAllCommits(branch, 'SHA')
        .some((sha) => patches.has(sha))
    )
    .map((branch) => ({
      branch,
      commits: new Map(
        context.engine
          .getAllCommits(branch, 'SHA')
          .filter((sha) => patches.has(sha))
          .map((sha) => [sha, (patches.get(sha) as string[]).join('')])
      ),
    }));
  return plan;
}

function changedLines(hunk: string, start: number): number[] {
  let line = start;
  const removed: number[] = [];
  for (const text of hunk.split('\n').slice(1)) {
    if (text.startsWith('-')) {
      removed.push(line);
      line++;
    } else if (text.startsWith(' ')) line++;
  }
  // In a zero-context insertion, the old start is the preceding line, not
  // the first added line. At the start of a file, use its first existing line.
  return removed.length ? removed : [Math.max(1, start)];
}

function unappliedPatchPath(): string {
  return path.join(worktreeGitDirectory(), 'gt-absorb-unapplied.patch');
}

/** Amend the planned commits inside each owning branch, restack descendants,
 * and re-stage any hunks that could not be absorbed.
 */
export function applyAbsorb(plan: AbsorbPlan, context: TContext): string[] {
  const original = context.engine.currentBranchPrecondition;
  if (git(['diff', '--name-only']).length) {
    throw new ExitFailedError(
      'Stage or stash unstaged tracked changes before absorbing.'
    );
  }
  // Checkpoint unabsorbed hunks before history changes so a restack conflict
  // (resolved via gt continue/abort) can never lose them.
  const restacked = context.engine.getRelativeStack(
    plan.branches[0].branch,
    SCOPE.UPSTACK_EXCLUSIVE
  );
  const unassigned = plan.unassigned.map((entry) => entry.patch).join('');
  if (unassigned) fs.writeFileSync(unappliedPatchPath(), unassigned);
  assertBranchesAvailable(plan.branches.map((entry) => entry.branch));
  const updates = plan.branches.map(({ branch, commits }) => {
    context.engine.assertBranchMutable(branch);
    return {
      branch,
      before: context.engine.getRevision(branch),
      after: prepareRewrittenCommits(
        {
          commits: context.engine.getAllCommits(branch, 'SHA').reverse(),
          patches: commits,
          noVerify: context.engine.noVerify,
          unidiffZero: true,
        },
        context
      ),
    };
  });
  git(['read-tree', '--reset', '-u', 'HEAD']);
  git(['update-ref', '--stdin'], {
    input:
      'start\n' +
      updates
        .map((u) => `update refs/heads/${u.branch} ${u.after} ${u.before}`)
        .join('\n') +
      '\nprepare\ncommit\n',
  });
  git(['read-tree', '--reset', '-u', `refs/heads/${original}`]);
  context.engine.rebuild();
  const beforeRestack = new Map(
    restacked.map((branch) => [branch, context.engine.getRevision(branch)])
  );
  // Native summarizes the successful restacks itself. Do not suppress conflict
  // guidance or notices about frozen/blocked branches along with progress.
  // restackBranches consumes the array it is given.
  restackBranches([...restacked], context, { printProgress: false });
  context.engine.checkoutBranch(original);
  if (unassigned) restageUnassigned(context);
  return restacked.filter(
    (branch) => beforeRestack.get(branch) !== context.engine.getRevision(branch)
  );
}

function restageUnassigned(context: TContext): void {
  const file = unappliedPatchPath();
  const patch = fs.readFileSync(file, 'utf8');
  try {
    // Absorbed insertions/deletions can shift the remaining hunks. Merge from
    // their original blob rather than guessing a new position without context.
    git(['apply', '--index', '--3way', '--binary', '--unidiff-zero'], {
      input: patch,
    });
  } catch {
    context.splog.warn(
      `Could not re-stage the unabsorbed hunks; they are saved at ${file}.`
    );
    return;
  }
  // Native says nothing here; the hunks simply stay staged.
  fs.rmSync(file, { force: true });
}
