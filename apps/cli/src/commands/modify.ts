import yargs from 'yargs';
import { commitAmendAction } from '../actions/commit_amend';
import { commitCreateAction } from '../actions/commit_create';
import { editBranchAction } from '../actions/edit_branch';
import { ExitFailedError } from '../lib/errors';
import { graphite } from '../lib/runner';
import { applyBranchPatches } from '../actions/modify_into';
import { journalGit } from '../lib/operations/journal';
import { stageChanges } from '../actions/stage_changes';

const args = {
  all: {
    describe: `Stage all changes before committing.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'a',
  },
  commit: {
    describe: `Create a new commit instead of amending the current commit.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'c',
  },
  edit: {
    describe: `If passed, open an editor to edit the commit message when amending.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'e',
  },
  'interactive-rebase': {
    describe: `Start a git interactive rebase on the commits in this branch.`,
    demandOption: false,
    default: false,
    type: 'boolean',
  },
  into: {
    describe: `Apply staged changes to this downstack branch, then restack descendants.`,
    demandOption: false,
    type: 'string',
  },
  message: {
    describe: `The message for the new or amended commit.`,
    demandOption: false,
    type: 'string',
    alias: 'm',
  },
  patch: {
    describe: `Pick hunks to stage before committing.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'p',
  },
  'reset-author': {
    describe: `Set the author of the amended commit to the current user.`,
    demandOption: false,
    default: false,
    type: 'boolean',
  },
  update: {
    describe: `Stage updates to tracked files only.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'u',
  },
  verbose: {
    describe: `Show commit diff in the commit-message editor.`,
    demandOption: false,
    count: true,
    alias: 'v',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'modify';
export const canonical = 'modify';
export const description =
  'Modify the current branch by amending its commit or creating a new commit.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    if (argv.commit && argv['reset-author'])
      throw new ExitFailedError('--reset-author requires an amend.');
    if (argv.into) {
      await stageChanges(
        {
          all: argv.all,
          update: argv.update,
          patch: argv.patch,
          offer: 'ALL',
        },
        context
      );
      return applyBranchPatches(
        [
          {
            branch: argv.into,
            patch: journalGit(
              ['diff', '--cached', '--binary', '--no-ext-diff'],
              { noTrim: true }
            ),
            message: argv.message,
            append: argv.commit,
            resetAuthor: argv['reset-author'],
          },
        ],
        context
      );
    }
    if (argv['interactive-rebase']) {
      return editBranchAction(context);
    }

    // Like Graphite: if this branch has no commits, always create a new one.
    const hasCommits =
      context.engine.getAllCommits(
        context.engine.currentBranchPrecondition,
        'SHA'
      ).length > 0;
    if (argv.commit || !hasCommits) {
      return commitCreateAction(
        {
          message: argv.message,
          addAll: argv.all,
          update: argv.update,
          verbose: argv.verbose,
          patch: argv.patch,
        },
        context
      );
    }

    return commitAmendAction(
      {
        message: argv.message,
        noEdit: !argv.edit || !!argv.message || !context.interactive,
        addAll: argv.all,
        update: argv.update,
        resetAuthor: argv['reset-author'],
        verbose: argv.verbose,
        patch: argv.patch,
      },
      context
    );
  });
