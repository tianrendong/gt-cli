import yargs from 'yargs';
import { splitCurrentBranch } from '../../actions/split';
import { graphite } from '../../lib/runner';
import { SCOPE } from '../../lib/engine/scope_spec';
import { restackBranches } from '../../actions/restack';
import { ExitFailedError } from '../../lib/errors';
import { uncommittedTrackedChangesPrecondition } from '../../lib/preconditions';
import { runGitCommand } from '../../lib/git/runner';
import { TContext } from '../../lib/context';
import {
  readMetadataRef,
  writeMetadataRef,
} from '../../lib/engine/metadata_ref';
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = {
  names: {
    type: 'string',
    describe:
      'Branch names for non-interactive splitting: one per commit for --by-commit, or a single new parent name for --by-file.',
  },
  ['by-commit']: {
    describe: `Split by commit - slice up the history of this branch.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: ['c', 'commit'],
  },
  ['by-hunk']: {
    describe: `Split by hunk - split into new single-commit branches.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: ['h', 'hunk'],
  },
  ['by-file']: {
    describe: `Split by file - takes a pathspec and splits matching files into a new parent branch. Repeat the flag for multiple patterns.`,
    demandOption: false,
    type: 'string',
    array: true,
    alias: ['f', 'file'],
  },
} as const;
type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'split';
export const canonical = 'branch split';
export const aliases = ['sp'];
export const description =
  'Split the current branch into multiple single-commit branches.';
export const builder = args;
export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    if (argv['by-file']?.length) {
      if (argv['by-hunk'] || argv['by-commit'])
        throw new ExitFailedError('Choose a single splitting strategy.');
      return splitByFile(
        argv['by-file'],
        argv.names?.split(',').map((name) => name.trim()),
        context
      );
    }
    if (argv.names) {
      if (argv['by-hunk'])
        throw new ExitFailedError(
          '--names requires splitting by commit, not by hunk.'
        );
      uncommittedTrackedChangesPrecondition();
      const branch = context.engine.currentBranchPrecondition;
      context.engine.assertBranchMutable(branch);
      const names = argv.names.split(',').map((name) => name.trim());
      const commits = context.engine.getAllCommits(branch, 'SHA');
      if (
        names.length !== commits.length ||
        new Set(names).size !== names.length ||
        names.length < 2
      ) {
        throw new ExitFailedError(
          'Supply one unique branch name per commit, oldest to newest (at least two).'
        );
      }
      for (const name of names) {
        runGitCommand({
          args: ['check-ref-format', '--branch', name],
          onError: 'throw',
          resource: 'splitName',
        });
        if (name !== branch && context.engine.branchExists(name))
          throw new ExitFailedError(`Branch ${name} already exists.`);
      }
      const children = context.engine.getRelativeStack(
        branch,
        SCOPE.UPSTACK_EXCLUSIVE
      );
      context.engine.detach();
      context.engine.applySplitToCommits({
        branchToSplit: branch,
        branchNames: names,
        branchPoints: commits.map((_, i) => i),
      });
      restackBranches(children, context);
      return;
    }
    return splitCurrentBranch(
      {
        style: argv['by-hunk']
          ? 'hunk'
          : argv['by-commit']
          ? 'commit'
          : undefined,
      },
      context
    );
  });

/** Extract files matching the pathspecs into a new parent branch. The current
 * branch keeps the remaining changes; descendants are restacked.
 */
// eslint-disable-next-line max-lines-per-function
async function splitByFile(
  pathspecs: string[],
  names: string[] | undefined,
  context: TContext
): Promise<void> {
  uncommittedTrackedChangesPrecondition();
  const branch = context.engine.currentBranchPrecondition;
  context.engine.assertBranchMutable(branch);
  const parent = context.engine.getParentPrecondition(branch);
  const base = readMetadataRef(branch).parentBranchRevision as string;
  const patch = runGitCommand({
    args: [
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-color',
      base,
      context.engine.getRevision(branch),
      '--',
      ...pathspecs,
    ],
    options: { noTrim: true },
    onError: 'throw',
    resource: 'splitByFilePatch',
  });
  if (!patch.trim())
    throw new ExitFailedError('No committed changes match the pathspec.');
  const name =
    names?.[0] ??
    (context.interactive
      ? (
          await context.prompts({
            type: 'text',
            name: 'value',
            message: 'Name for the new parent branch',
            initial: `${branch}_split`,
          })
        ).value
      : undefined);
  if (!name)
    throw new ExitFailedError(
      'Provide --names <new-parent-branch> when splitting by file non-interactively.'
    );
  runGitCommand({
    args: ['check-ref-format', '--branch', name],
    onError: 'throw',
    resource: 'splitByFileName',
  });
  if (context.engine.branchExists(name))
    throw new ExitFailedError(`Branch ${name} already exists.`);
  const sha = prepareSplitCommit({ base, patch, message: name }, context);
  runGitCommand({
    args: ['branch', name, sha],
    onError: 'throw',
    resource: 'splitByFileBranch',
  });
  writeMetadataRef(name, {
    parentBranchName: parent,
    parentBranchRevision: base,
  });
  context.engine.rebuild();
  context.engine.setParent(branch, name);
  restackBranches(
    context.engine.getRelativeStack(branch, SCOPE.UPSTACK),
    context
  );
  context.engine.checkoutBranch(branch);
  context.splog.info(
    `Split ${pathspecs.join(' ')} into new parent branch ${name}.`
  );
}

function prepareSplitCommit(
  args: { base: string; patch: string; message: string },
  context: TContext
): string {
  return performInTmpDirSync((directory) => {
    const worktree = path.join(directory, 'worktree');
    const git = (argv: string[], input?: string): string =>
      runGitCommand({
        args: argv,
        options: { cwd: worktree, input },
        onError: 'throw',
        resource: 'splitByFileCommit',
      });
    runGitCommand({
      args: ['worktree', 'add', '--detach', worktree, args.base],
      onError: 'throw',
      resource: 'splitByFileWorktree',
    });
    try {
      git(['apply', '--index', '--binary'], args.patch);
      git([
        'commit',
        '-m',
        args.message,
        ...(context.engine.noVerify ? ['--no-verify'] : []),
      ]);
      return git(['rev-parse', 'HEAD']);
    } finally {
      runGitCommand({
        args: ['worktree', 'remove', '--force', worktree],
        onError: 'ignore',
        resource: 'splitByFileCleanup',
      });
    }
  });
}

function performInTmpDirSync<T>(handler: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-split-'));
  try {
    return handler(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
