import chalk from 'chalk';
import { TContext } from '../lib/context';
import { TBranchPRInfo } from '../lib/engine/metadata_ref';

export async function showBranchInfo(
  branchName: string,
  opts: { patch: boolean; diff: boolean; body: boolean; stat?: boolean },
  context: TContext
): Promise<void> {
  const output = getBranchInfo({ branchName }, context);

  const parentBranchName = context.engine.getParent(branchName);
  if (parentBranchName) {
    output.push(`${chalk.cyan('Parent')}: ${parentBranchName}`);
  }

  const children = context.engine.getChildren(branchName);
  if (children.length) {
    // Native 1.8.6 prints the heading only; `gt children` lists the names.
    output.push(`${chalk.cyan('Children')}:`);
  }

  const body = opts.body && context.engine.getPrInfo(branchName)?.body;
  if (body) {
    output.push('');
    output.push(body);
  }

  const patch = opts.patch && !opts.diff;
  output.push('');
  output.push(context.engine.showCommits(branchName, patch, opts.stat));

  if (opts.diff || (opts.stat && !patch)) {
    output.push('');
    output.push(context.engine.showDiff(branchName, opts.stat));
  }

  context.splog.page(output.join('\n'));
}

export function getBranchInfo(
  args: {
    branchName: string;
    displayAsCurrent?: boolean;
    showCommitNames?: 'STANDARD' | 'REVERSE';
    worktreeName?: string;
  },
  context: TContext
): string[] {
  const prInfo = context.engine.isTrunk(args.branchName)
    ? undefined
    : context.engine.getPrInfo(args.branchName);

  // With commit names, one process returns both the committer date and the
  // commit lines for the whole range instead of one process per field.
  const commits = args.showCommitNames
    ? context.engine
        .getAllCommits(args.branchName, 'READABLE_WITH_DATE')
        .map((entry) => {
          const separator = entry.indexOf('\x1f');
          return separator < 0
            ? { committerDate: '', readable: entry }
            : {
                committerDate: entry.slice(0, separator),
                readable: entry.slice(separator + 1),
              };
        })
    : undefined;
  const committerDate = commits
    ? commits[0]?.committerDate ?? ''
    : context.engine.getAllCommits(args.branchName, 'COMMITTER_DATE')[0] ?? '';

  const prTitleLine = getPRTitleLine(prInfo);
  const status =
    prInfo?.state === 'MERGED'
      ? '(merged)'
      : getBranchStatus(args.branchName, context);
  // Only display a real Graphite version attached to a known PR. GitHub-only
  // submissions have no Graphite version number; do not invent one.
  const version = prInfo?.number
    ? context.engine.getLastSubmittedVersion(args.branchName)?.versionNumber
    : undefined;
  const versionLine =
    version !== undefined
      ? chalk.dim(
          `Last submitted version: v${version}${
            context.engine.getPublishedRevision(args.branchName) !==
            context.engine.getRevision(args.branchName)
              ? ' (local changes, need submit)'
              : ''
          }`
        )
      : undefined;
  const branchInfoLines = [
    `${
      args.displayAsCurrent
        ? chalk.cyan(`${args.branchName} (current)`)
        : chalk.blueBright(args.branchName)
    }${status ? ` ${chalk.yellow(status)}` : ''}${
      args.worktreeName ? ` ${chalk.dim(`(${args.worktreeName})`)}` : ''
    }`,
    `${chalk.dim(committerDate)}`,
    ...(prTitleLine ? ['', prTitleLine] : []),
    ...(prInfo?.url ? [chalk.magenta(prInfo.url)] : []),
    ...(versionLine ? [versionLine] : []),
    '',
    ...(commits
      ? getCommitLines(
          commits.map((commit) => commit.readable),
          args.showCommitNames === 'REVERSE'
        )
      : []),
  ];

  return prInfo?.state === 'MERGED' || prInfo?.state === 'CLOSED'
    ? branchInfoLines.map((line) => chalk.dim(line))
    : branchInfoLines;
}

// A frozen branch is intentionally left behind; native gt shows "frozen"
// instead of also suggesting a restack that would skip it.
export function getBranchStatus(
  branchName: string,
  context: TContext
): string | undefined {
  if (context.engine.getPrInfo(branchName)?.state === 'MERGED')
    return undefined;
  if (context.engine.isBranchFrozen(branchName)) return '(frozen)';
  return context.engine.isBranchFixed(branchName)
    ? undefined
    : '(needs restack)';
}

function getPRTitleLine(prInfo: TBranchPRInfo | undefined): string | undefined {
  if (!prInfo?.title || !prInfo?.number) {
    return undefined;
  }
  return `${chalk.yellow(`PR #${prInfo.number}`)} ${prInfo.title}`;
}

function getCommitLines(readableLines: string[], reverse: boolean) {
  const lines = readableLines.map((line) => chalk.dim(line));

  return reverse ? lines.reverse() : lines;
}
