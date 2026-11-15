import yargs from 'yargs';
import { submitAction } from '../actions/submit/submit_action';
import { SCOPE } from '../lib/engine/scope_spec';
import { ExitFailedError } from '../lib/errors';
import { graphite } from '../lib/runner';
import { args as sharedArgs } from './shared-commands/submit';
import { restackBranches } from '../actions/restack';
import { TContext } from '../lib/context';

const args = {
  ...sharedArgs,
  select: {
    describe:
      'Reports the PRs that would be submitted and asks the user to select which should be updated/created.',
    type: 'boolean',
    default: false,
  },
  stack: {
    describe:
      'Submit descendants of the current branch in addition to its ancestors. Pass --no-stack to submit narrowly and skip the prompt to include upstack branches with open PRs.',
    type: 'boolean',
    alias: 's',
  },
  ai: {
    describe:
      'Graphite AI PR metadata generation is not supported by this GitHub-only CLI.',
    type: 'boolean',
    default: false,
  },
  'no-ai': {
    describe:
      'No-op compatibility flag; this GitHub-only CLI never uses Graphite AI.',
    type: 'boolean',
    default: false,
  },
  cli: {
    describe: 'No-op compatibility flag; this CLI edits PR metadata locally.',
    type: 'boolean',
    default: false,
  },
  web: {
    describe:
      'Graphite-hosted web PR metadata editing is not supported by this GitHub-only CLI.',
    type: 'boolean',
    default: false,
    alias: 'w',
  },
  'edit-title': {
    describe:
      'Input the PR title interactively for every submitted PR. Default only prompts for new PRs.',
    type: 'boolean',
  },
  'edit-description': {
    describe:
      'Input the PR description interactively for every submitted PR. Default only prompts for new PRs.',
    type: 'boolean',
  },
  'no-edit-title': {
    describe:
      "Don't prompt for the PR title. Takes precedence over --edit-title and --edit.",
    type: 'boolean',
    default: false,
  },
  'no-edit-description': {
    describe:
      "Don't prompt for the PR description. Takes precedence over --edit-description and --edit.",
    type: 'boolean',
    default: false,
  },
  comment: {
    describe: 'Add a comment to each submitted pull request.',
    type: 'string',
  },
  'merge-when-ready': {
    describe:
      'Enable GitHub auto-merge using squash, subject to repository rules.',
    type: 'boolean',
    default: false,
    alias: 'm',
  },
  'team-reviewers': {
    describe: 'Use --reviewers org/team-slug with GitHub CLI semantics.',
    type: 'string',
    alias: 't',
  },
  'rerequest-review': {
    describe: 'Re-request reviews from previous GitHub reviewers.',
    type: 'boolean',
    default: false,
  },
  restack: {
    describe:
      'Restack branches before submitting. If there are conflicts, output the branch names that could not be restacked.',
    type: 'boolean',
    default: false,
  },
  'target-trunk': {
    describe:
      'Which trunk to open PRs against on the remote. Never rebases or reparents local branches.',
    type: 'string',
  },
  'ignore-out-of-sync-trunk': {
    describe:
      'Suppress the advisory warning when local trunk differs from its upstream branch.',
    type: 'boolean',
    default: false,
  },
  view: {
    describe: 'Open the PR in your browser after submitting.',
    type: 'boolean',
    default: false,
    alias: 'v',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'submit';
export const canonical = 'submit';
export const aliases = ['ss'];
export const description =
  'Idempotently force push branches to GitHub, creating or updating pull requests.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    if (argv.ai) {
      throw new ExitFailedError(
        'This GitHub-only CLI does not support Graphite AI PR metadata generation.'
      );
    }
    if (argv.web) {
      throw new ExitFailedError(
        'This GitHub-only CLI does not support gt submit --web.'
      );
    }
    const includeUpstack =
      argv.stack ??
      (await shouldIncludeUpstack(
        argv.branch,
        !argv['dry-run'] && !argv.select,
        context
      ));
    if (argv.restack && !argv['dry-run']) {
      restackBranches(
        context.engine.getRelativeStack(
          argv.branch ?? context.engine.currentBranchPrecondition,
          includeUpstack ? SCOPE.STACK : SCOPE.DOWNSTACK
        ),
        context
      );
    }

    await submitAction(
      {
        scope: includeUpstack ? SCOPE.STACK : SCOPE.DOWNSTACK,
        editPRFieldsInline: undefined,
        editTitle: editMode(argv['no-edit-title'], argv['edit-title'], argv),
        editBody: editMode(
          argv['no-edit-description'],
          argv['edit-description'],
          argv
        ),
        draft: argv.draft,
        publish: argv.publish,
        dryRun: argv['dry-run'],
        updateOnly: argv['update-only'],
        reviewers:
          [argv.reviewers, argv['team-reviewers']]
            .filter((s) => s !== undefined)
            .join(',') || undefined,
        confirm: argv.confirm,
        forcePush: argv.force,
        select: argv.select,
        always: argv.always,
        branch: argv.branch,
        stackSync: argv['stack-sync'],
        preferLocal: argv.reconcile === 'local',
        comment: argv.comment,
        mergeWhenReady: argv['merge-when-ready'],
        rerequestReview: argv['rerequest-review'],
        targetTrunk: argv['target-trunk'],
        view: argv.view,
        ignoreOutOfSyncTrunk: argv['ignore-out-of-sync-trunk'],
      },
      context
    );
  });

function editMode(
  noEditField: boolean,
  editField: boolean | undefined,
  argv: { edit?: boolean; 'no-edit': boolean }
): 'all' | 'new' | 'none' {
  if (noEditField || editField === false) return 'none';
  if (editField) return 'all';
  if (argv['no-edit']) return 'none';
  if (argv.edit) return 'all';
  return 'new';
}

/** Like gt: by default, interactively offer to include branches above the
 * current one that already have open PRs. --stack/--no-stack skip the prompt.
 */
async function shouldIncludeUpstack(
  branch: string | undefined,
  allowPrompt: boolean,
  context: TContext
): Promise<boolean> {
  if (!context.interactive || !allowPrompt) return false;
  const upstack = context.engine
    .getRelativeStack(
      branch ?? context.engine.currentBranchPrecondition,
      SCOPE.UPSTACK_EXCLUSIVE
    )
    .filter(
      (branchName) => context.engine.getPrInfo(branchName)?.state === 'OPEN'
    );
  if (!upstack.length) return false;
  return (
    await context.prompts({
      type: 'confirm',
      name: 'value',
      message: `Include ${
        upstack.length
      } upstack branch(es) with open PRs (${upstack.join(', ')})?`,
      initial: true,
    })
  ).value;
}
