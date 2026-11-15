import yargs from 'yargs';
import { createBranchAction } from '../actions/create_branch';
import { runGitCommand } from '../lib/git/runner';
import { graphite } from '../lib/runner';

const args = {
  sha: {
    describe: 'The commit to revert.',
    demandOption: true,
    type: 'string',
    positional: true,
    hidden: true,
  },
  edit: {
    describe: 'Edit the commit message.',
    type: 'boolean',
    default: false,
    alias: 'e',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'revert [sha]';
export const canonical = 'revert';
export const description =
  'Create a branch that reverts a commit on the trunk branch.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    const shortSha = argv.sha.slice(0, 12);
    const branchName = `revert-${shortSha}`;
    const subject = runGitCommand({
      args: ['log', '-1', '--format=%s', argv.sha],
      onError: 'throw',
      resource: 'revertSubject',
    });

    context.engine.checkoutBranch(context.engine.trunk);
    const patch = runGitCommand({
      args: ['show', '--format=', '--binary', argv.sha],
      onError: 'throw',
      resource: 'revertPatch',
      options: { noTrim: true },
    });
    runGitCommand({
      args: ['apply', '--reverse', '--index'],
      onError: 'throw',
      resource: 'revertApply',
      options: { input: patch },
    });

    await createBranchAction(
      {
        branchName,
        message: argv.edit ? undefined : `Revert "${subject}"`,
        all: false,
        insert: false,
        patch: false,
      },
      context
    );
  });
