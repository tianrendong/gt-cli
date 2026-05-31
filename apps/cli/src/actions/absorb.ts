import chalk from 'chalk';
import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { ExitFailedError, RebaseConflictError } from '../lib/errors';
import { persistContinuation } from './persist_continuation';
import { printConflictStatus } from './print_conflict_status';
import { restackBranches } from './restack';

type THunk = {
  oldPath: string;
  oldStart: number;
  oldCount: number;
  lines: string[];
};

type TParsedFile = {
  oldPath: string;
  header: string[];
  hunks: THunk[];
};

type TRoutedHunk = {
  targetSha: string;
  oldPath: string;
  header: string[];
  hunk: THunk;
};

type TTargetPlan = { subject: string; files: Map<string, TRoutedHunk[]> };
type TBranchPlan = Map<string, TTargetPlan>;
type TAbsorbPlan = Map<string, TBranchPlan>;

type TCommitMaps = {
  commitToBranch: Map<string, string>;
  commitSubject: Map<string, string>;
  commitOrder: Map<string, number>;
};

export async function absorbAction(
  args: { dryRun: boolean; force: boolean; all: boolean },
  context: TContext
): Promise<void> {
  const currentBranch = context.engine.currentBranchPrecondition;
  if (context.engine.isTrunk(currentBranch)) {
    throw new ExitFailedError(`Cannot absorb changes into trunk.`);
  }

  // Stage tracked modifications first when --all is passed (like `git add -u`).
  if (args.all) {
    context.engine.stageTrackedModifications();
  }

  if (!context.engine.detectStagedChanges()) {
    throw new ExitFailedError(
      args.all
        ? `No tracked changes to absorb.`
        : `No staged changes to absorb. Stage changes or pass \`--all\` to include tracked modifications.`
    );
  }

  // Downstack branches, ordered bottom-to-top (closest to trunk first),
  // excluding trunk.
  const downstack = context.engine
    .getRelativeStack(currentBranch, SCOPE.DOWNSTACK)
    .filter((branchName) => !context.engine.isTrunk(branchName));

  if (downstack.length === 0) {
    throw new ExitFailedError(`No downstack commits to absorb into.`);
  }

  const maps = buildCommitMaps(downstack, context);
  const { routed, unroutedFiles, unroutedPatch } = routeStagedHunks(
    currentBranch,
    maps,
    context
  );

  if (routed.length === 0) {
    context.splog.info(
      `No staged hunks could be routed to a downstack commit.`
    );
    if (unroutedFiles.size > 0) {
      context.splog.tip(
        `Unroutable changes remain staged in: ${[...unroutedFiles].join(', ')}`
      );
    }
    return;
  }

  const plan = groupRoutedHunks(routed, maps);
  printPlan({ plan, downstack, unroutedFiles }, context);

  if (args.dryRun) {
    context.splog.tip(`Run without \`--dry-run\` to apply.`);
    return;
  }

  // Clear the working tree so we can check out downstack branches during the
  // surgery. All changes we need are captured in-memory (routed patches +
  // unroutedPatch), so this is safe.
  context.engine.resetWorkingTreeToHead();

  applyAbsorbPlan(plan, downstack, context);

  context.engine.checkoutBranch(currentBranch);

  // Restore any changes that could not be absorbed back into the working tree.
  if (unroutedPatch && !context.engine.restoreWorktreePatch(unroutedPatch)) {
    context.splog.warn(
      `Could not automatically restore un-absorbable changes; they may need to be re-applied manually.`
    );
  }

  context.splog.info(chalk.green(`Absorb complete.`));
}

function buildCommitMaps(downstack: string[], context: TContext): TCommitMaps {
  // Iterate top-to-bottom so commits closest to the tip get the lowest order
  // index (i.e. are treated as the most recent to have touched a line).
  const commitToBranch = new Map<string, string>();
  const commitSubject = new Map<string, string>();
  const commitOrder = new Map<string, number>();
  let order = 0;
  for (const branchName of [...downstack].reverse()) {
    const shas = context.engine.getAllCommits(branchName, 'SHA');
    const subjects = context.engine.getAllCommits(branchName, 'SUBJECT');
    shas.forEach((sha, idx) => {
      commitToBranch.set(sha, branchName);
      commitSubject.set(sha, subjects[idx] ?? '');
      commitOrder.set(sha, order++);
    });
  }
  return { commitToBranch, commitSubject, commitOrder };
}

function routeStagedHunks(
  currentBranch: string,
  maps: TCommitMaps,
  context: TContext
): {
  routed: TRoutedHunk[];
  unroutedFiles: Set<string>;
  unroutedPatch: string;
} {
  const parsedFiles = parseStagedDiff(context.engine.getStagedDiff());
  const routed: TRoutedHunk[] = [];
  const unroutedFiles = new Set<string>();
  const unroutedByFile = new Map<string, TRoutedHunk[]>();
  for (const file of parsedFiles) {
    for (const hunk of file.hunks) {
      const targetSha = routeHunk(
        {
          branch: currentBranch,
          hunk,
          commitToBranch: maps.commitToBranch,
          commitOrder: maps.commitOrder,
        },
        context
      );
      const entry: TRoutedHunk = {
        targetSha: targetSha ?? '',
        oldPath: file.oldPath,
        header: file.header,
        hunk,
      };
      if (targetSha) {
        routed.push(entry);
      } else {
        unroutedFiles.add(file.oldPath);
        if (!unroutedByFile.has(file.oldPath)) {
          unroutedByFile.set(file.oldPath, []);
        }
        (unroutedByFile.get(file.oldPath) as TRoutedHunk[]).push(entry);
      }
    }
  }
  return {
    routed,
    unroutedFiles,
    unroutedPatch: unroutedByFile.size > 0 ? buildPatch(unroutedByFile) : '',
  };
}

function groupRoutedHunks(
  routed: TRoutedHunk[],
  maps: TCommitMaps
): TAbsorbPlan {
  const plan: TAbsorbPlan = new Map();
  for (const r of routed) {
    const branchName = maps.commitToBranch.get(r.targetSha) as string;
    if (!plan.has(branchName)) {
      plan.set(branchName, new Map());
    }
    const branchPlan = plan.get(branchName) as TBranchPlan;
    if (!branchPlan.has(r.targetSha)) {
      branchPlan.set(r.targetSha, {
        subject: maps.commitSubject.get(r.targetSha) ?? '',
        files: new Map(),
      });
    }
    const target = branchPlan.get(r.targetSha) as TTargetPlan;
    if (!target.files.has(r.oldPath)) {
      target.files.set(r.oldPath, []);
    }
    (target.files.get(r.oldPath) as TRoutedHunk[]).push(r);
  }
  return plan;
}

function printPlan(
  args: {
    plan: TAbsorbPlan;
    downstack: string[];
    unroutedFiles: Set<string>;
  },
  context: TContext
): void {
  const { plan, downstack, unroutedFiles } = args;
  context.splog.info(chalk.bold(`Absorb plan:`));
  for (const branchName of downstack) {
    const branchPlan = plan.get(branchName);
    if (!branchPlan) {
      continue;
    }
    context.splog.info(`  ${chalk.cyan(branchName)}`);
    for (const [sha, target] of branchPlan) {
      const hunkCount = [...target.files.values()].reduce(
        (acc, hunks) => acc + hunks.length,
        0
      );
      context.splog.info(
        `    ${chalk.yellow(sha.slice(0, 8))} ${target.subject} ${chalk.gray(
          `(${hunkCount} hunk${hunkCount === 1 ? '' : 's'})`
        )}`
      );
    }
  }
  if (unroutedFiles.size > 0) {
    context.splog.info(
      chalk.gray(
        `  Unroutable changes will remain staged in: ${[...unroutedFiles].join(
          ', '
        )}`
      )
    );
  }
}

function applyAbsorbPlan(
  plan: TAbsorbPlan,
  downstack: string[],
  context: TContext
): void {
  // Process branches bottom-to-top so each branch's parent is settled before we
  // amend it. After amending a branch, restack its descendants.
  for (const branchName of downstack) {
    const branchPlan = plan.get(branchName);
    if (!branchPlan) {
      continue;
    }

    const fixups = [...branchPlan.values()].map((target) => ({
      subject: target.subject,
      patch: buildPatch(target.files),
    }));

    const result = context.engine.absorbIntoBranch(branchName, fixups);
    if (result.result === 'APPLY_FAILED') {
      throw new ExitFailedError(
        `Failed to apply absorbed changes for commit "${result.subject}" on ${branchName}. Resolve manually and retry.`
      );
    }
    if (result.result === 'REBASE_CONFLICT') {
      handleAbsorbConflict(branchName, result.rebasedBranchBase, context);
    }

    context.splog.info(
      `Absorbed ${fixups.length} change${
        fixups.length === 1 ? '' : 's'
      } into ${chalk.green(branchName)}.`
    );

    // Restack descendants onto the amended branch.
    const children = context.engine
      .getRelativeStack(branchName, SCOPE.UPSTACK_EXCLUSIVE)
      .filter((name) => !context.engine.isTrunk(name));
    restackBranches(children, context);
  }
}

function handleAbsorbConflict(
  branchName: string,
  rebasedBranchBase: string,
  context: TContext
): never {
  const remaining = context.engine
    .getRelativeStack(branchName, SCOPE.UPSTACK_EXCLUSIVE)
    .filter((name) => !context.engine.isTrunk(name));
  persistContinuation(
    { branchesToRestack: remaining, rebasedBranchBase },
    context
  );
  printConflictStatus(
    `Hit conflict absorbing changes into ${chalk.yellow(branchName)}.`,
    context
  );
  throw new RebaseConflictError();
}

function routeHunk(
  args: {
    branch: string;
    hunk: THunk;
    commitToBranch: Map<string, string>;
    commitOrder: Map<string, number>;
  },
  context: TContext
): string | undefined {
  const { hunk } = args;
  // New-file content (no pre-image) cannot belong to an existing commit.
  if (hunk.oldPath === '/dev/null') {
    return undefined;
  }

  let startLine: number;
  let endLine: number;
  if (hunk.oldCount === 0) {
    // Pure insertion: anchor on the line it was inserted after.
    startLine = Math.max(1, hunk.oldStart);
    endLine = startLine;
  } else {
    startLine = hunk.oldStart;
    endLine = hunk.oldStart + hunk.oldCount - 1;
  }

  let blamed: string[];
  try {
    blamed = context.engine.blameLines({
      rev: args.branch,
      file: hunk.oldPath,
      startLine,
      endLine,
    });
  } catch {
    return undefined;
  }

  let best: string | undefined;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (const sha of blamed) {
    const ord = args.commitOrder.get(sha);
    if (ord !== undefined && ord < bestOrder) {
      bestOrder = ord;
      best = sha;
    }
  }
  return best;
}

function parseStagedDiff(diff: string): TParsedFile[] {
  const lines = diff.split('\n');
  const files: TParsedFile[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      i++;
    }
    const block = lines.slice(start, i);
    const parsed = parseFileBlock(block);
    if (parsed) {
      files.push(parsed);
    }
  }
  return files;
}

function parseFileBlock(block: string[]): TParsedFile | undefined {
  const firstHunkIdx = block.findIndex((l) => l.startsWith('@@'));
  if (firstHunkIdx === -1) {
    // Pure mode change / rename with no content hunks; nothing to absorb.
    return undefined;
  }
  const header = block.slice(0, firstHunkIdx);

  let oldPath = '/dev/null';
  const minusLine = header.find((l) => l.startsWith('--- '));
  if (minusLine) {
    const p = minusLine.slice(4).trim();
    oldPath = p === '/dev/null' ? '/dev/null' : stripPrefix(p);
  }

  const hunks: THunk[] = [];
  let h = firstHunkIdx;
  while (h < block.length) {
    if (!block[h].startsWith('@@')) {
      h++;
      continue;
    }
    const hunkStart = h;
    h++;
    while (h < block.length && !block[h].startsWith('@@')) {
      h++;
    }
    const hunkLines = block.slice(hunkStart, h);
    const m = hunkLines[0].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) {
      continue;
    }
    hunks.push({
      oldPath,
      oldStart: parseInt(m[1], 10),
      oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
      lines: hunkLines,
    });
  }

  return { oldPath, header, hunks };
}

function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) {
    return path.slice(2);
  }
  return path;
}

function buildPatch(files: Map<string, TRoutedHunk[]>): string {
  const parts: string[] = [];
  for (const hunks of files.values()) {
    if (hunks.length === 0) {
      continue;
    }
    parts.push(hunks[0].header.join('\n'));
    for (const r of hunks) {
      parts.push(r.hunk.lines.join('\n'));
    }
  }
  // Ensure the patch ends with a trailing newline.
  return parts.join('\n') + '\n';
}
