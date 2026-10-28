import chalk from 'chalk';
import { TContext } from '../../lib/context';
import { TScopeSpec } from '../../lib/engine/scope_spec';
import { ExitFailedError, KilledError } from '../../lib/errors';
import { CommandFailedError } from '../../lib/git/runner';
import { getPRInfoForBranches } from './prepare_branches';
import { validateBranchesToSubmit } from './validate_branches';
import { submitPullRequest } from './submit_prs';
import {
  createPrBodyFooter,
  footerFooter,
  footerTitle,
} from '../create_pr_body_footer';
import { GitHubClient } from '../../lib/github/client';
import { cleanupGitHubStacks } from '../../lib/github/stack_cleanup';
import {
  preflightStackSync,
  prepareRemoteStacks,
  syncSubmittedStacks,
} from '../../lib/github/stack_sync';
import { submitExtras } from './submit_extras';
import { prepareGraphiteSubmission } from '../../lib/graphite_cloud/submit';

export type TSubmitEditMode = 'all' | 'new' | 'none';

// eslint-disable-next-line max-lines-per-function
export async function submitAction(
  args: {
    scope: TScopeSpec;
    editPRFieldsInline: boolean | undefined;
    draft: boolean;
    publish: boolean;
    dryRun: boolean;
    updateOnly: boolean;
    reviewers: string | undefined;
    confirm: boolean;
    forcePush: boolean;
    select: boolean;
    always: boolean;
    branch: string | undefined;
    stackSync?: boolean;
    preferLocal?: boolean;
    comment?: string;
    mergeWhenReady?: boolean;
    rerequestReview?: boolean;
    editTitle?: TSubmitEditMode;
    editBody?: TSubmitEditMode;
    targetTrunk?: string;
    view?: boolean;
    ignoreOutOfSyncTrunk?: boolean;
  },
  context: TContext
): Promise<void> {
  if (!context.repoConfig.getIsGithubIntegrationEnabled()) {
    throw new ExitFailedError(
      'GitHub integration is disabled. Enable it with gt repo github --enable before submitting PRs, or use git push for Git-only publishing.'
    );
  }
  // Check CLI pre-condition to warn early
  if (args.draft && args.publish) {
    throw new ExitFailedError(
      `Can't use both --publish and --draft flags in one command`
    );
  }
  await context.engine.populateRemoteShas();
  // Busy repositories advance trunk between sync and submit. Like Graphite,
  // warn without blocking publication; per-branch push leases protect others' work.
  const remoteTrunkSha = context.engine.getRemoteSha(context.engine.trunk);
  if (
    remoteTrunkSha &&
    remoteTrunkSha !== context.engine.getRevision(context.engine.trunk) &&
    !args.ignoreOutOfSyncTrunk
  ) {
    context.splog.warn(
      `${context.engine.trunk} is out of sync with its remote. PRs still target the remote branch; run gt sync when you want to update your local base.`
    );
  }
  const editModes = {
    title:
      args.editTitle ??
      (args.editPRFieldsInline === undefined
        ? 'new'
        : args.editPRFieldsInline
        ? 'all'
        : 'none'),
    body:
      args.editBody ??
      (args.editPRFieldsInline === undefined
        ? 'new'
        : args.editPRFieldsInline
        ? 'all'
        : 'none'),
  };
  if (args.dryRun) {
    context.splog.info(
      chalk.yellow(
        `Running submit in 'dry-run' mode. No branches will be pushed and no PRs will be opened or updated.`
      )
    );
    context.splog.newline();
    editModes.title = 'none';
    editModes.body = 'none';
  }

  if (!context.interactive) {
    editModes.title = 'none';
    editModes.body = 'none';

    context.splog.info(
      `Running in non-interactive mode. Inline prompts to fill PR fields will be skipped${
        !(args.draft || args.publish)
          ? ' and new PRs will be created in draft mode'
          : ''
      }.`
    );
    context.splog.newline();
  }

  const allBranchNames = context.engine
    .getRelativeStack(
      args.branch ?? context.engine.currentBranchPrecondition,
      args.scope
    )
    .filter((branchName) => !context.engine.isTrunk(branchName));

  const branchNames =
    args.select && context.interactive && !args.dryRun
      ? await selectBranches(context, allBranchNames)
      : allBranchNames;

  context.splog.info(
    chalk.blueBright(
      `🥞 Validating that this Graphite stack is ready to submit...`
    )
  );
  context.splog.newline();
  await validateBranchesToSubmit(branchNames, context);
  const stackSync =
    args.stackSync !== false &&
    context.repoConfig.getIsGithubIntegrationEnabled();
  const stackPlans = stackSync
    ? await preflightStackSync(context, branchNames, args.preferLocal)
    : [];
  const graphiteSubmission = prepareGraphiteSubmission(context, {
    branches: branchNames,
    dryRun: args.dryRun,
    always: args.always,
    targetTrunk: args.targetTrunk,
    stackSync,
  });

  context.splog.info(
    chalk.blueBright(
      '✏️  Preparing to submit PRs for the following branches...'
    )
  );
  const submissionInfos = await getPRInfoForBranches(
    {
      branchNames: branchNames,
      editTitle: editModes.title,
      editBody: editModes.body,
      draft: args.draft,
      publish: args.publish,
      updateOnly: args.updateOnly,
      reviewers: args.reviewers,
      dryRun: args.dryRun,
      select: args.select,
      always: args.always,
      targetTrunk: args.targetTrunk,
    },
    context
  );

  if (
    await shouldAbort(
      { ...args, hasAnyPrs: submissionInfos.length > 0 },
      context
    )
  ) {
    return;
  }

  if (stackSync) {
    prepareRemoteStacks(stackPlans, context);
    await cleanupGitHubStacks(context, {
      branches: new Set(
        stackPlans.flatMap((p) => p.local.branches.map((b) => b.branch))
      ),
    });
  }
  context.splog.info(
    chalk.blueBright('📨 Pushing to remote and creating/updating PRs...')
  );

  for (const submissionInfo of submissionInfos) {
    try {
      context.engine.pushBranch(submissionInfo.head, args.forcePush);
    } catch (err) {
      if (
        err instanceof CommandFailedError &&
        err.message.includes('stale info')
      ) {
        throw new ExitFailedError(
          [
            `Force-with-lease push of ${chalk.yellow(
              submissionInfo.head
            )} failed due to external changes to the remote branch.`,
            'If you are collaborating on this stack, try `gt downstack get` to pull in changes.',
            'Alternatively, use the `--force` option of this command to bypass the stale info warning.',
          ].join('\n')
        );
      }
      throw err;
    }

    await submitPullRequest([submissionInfo], context);
  }

  if (stackSync) {
    const mirroredBranches = [
      ...new Set([
        ...branchNames,
        ...stackPlans.flatMap((plan) =>
          plan.local.branches.map((b) => b.branch)
        ),
      ]),
    ];
    await syncSubmittedStacks(context, mirroredBranches);
  }
  await submitExtras(args, branchNames, context);

  if (stackSync) {
    removeStaleDependencyTrees(branchNames, context);
    await graphiteSubmission?.sync(branchNames);
    openSubmittedPR(args, context);
    return;
  }
  const client = GitHubClient.fromConfig(context.repoConfig);
  context.splog.info(
    chalk.blueBright('\n🌳 Updating dependency trees in PR bodies...')
  );

  for (const branch of branchNames) {
    const prInfo = context.engine.getPrInfo(branch);
    const footer = createPrBodyFooter(context, branch);

    if (!prInfo?.number || prInfo.state !== 'OPEN') continue;

    const body = updatePrBodyFooter(prInfo.body, footer);
    if (body !== (prInfo.body ?? '')) {
      client.pr(['edit', `${prInfo.number}`, '--body-file', '-'], body);
      context.engine.upsertPrInfo(branch, { body });
      context.splog.info(
        `${chalk.green(branch)}: ${prInfo.url} (${chalk.yellow('Updated')})`
      );
    }
  }

  await graphiteSubmission?.sync(branchNames);
  openSubmittedPR(args, context);
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const treeTitle = escapeRegExp(footerTitle.trim());
const treeEnd = escapeRegExp(footerFooter.trim());
// One generated tree: its title through its closing line. The tempered token
// stops a match from spanning a second title, so a stray heading in the
// author's text cannot swallow everything up to a later tree.
const generatedTree = new RegExp(
  `${treeTitle}(?:(?!${treeTitle})[\\s\\S])*?${treeEnd}`,
  'g'
);

export function hasPrBodyTree(body: string | undefined): boolean {
  return !!body && new RegExp(generatedTree.source).test(body);
}

/** Remove every gt-generated dependency tree, wherever it sits. Editors and
 * agents often leave trailing whitespace (or text) after the tree, and older
 * versions then appended a second tree instead of replacing the first. */
export function removePrBodyTrees(body: string): string {
  return body
    .split(generatedTree)
    .map((part, index) =>
      (index ? part.replace(/^\s+/, '') : part).replace(/\s+$/, '')
    )
    .filter(Boolean)
    .join('\n\n');
}

export function updatePrBodyFooter(
  body: string | undefined,
  footer: string
): string {
  const remaining = body ? removePrBodyTrees(body) : '';
  return remaining ? remaining + footer : footer;
}

/** GitHub Stacks replace the legacy dependency tree. A tree left from a
 * --no-stack-sync submit is never refreshed again, so it goes stale; remove it
 * (and any duplicates) once. Bodies without a tree cost nothing. */
function removeStaleDependencyTrees(
  branchNames: string[],
  context: TContext
): void {
  const client = GitHubClient.fromConfig(context.repoConfig);
  for (const branch of branchNames) {
    const prInfo = context.engine.getPrInfo(branch);
    if (
      !prInfo?.number ||
      prInfo.state !== 'OPEN' ||
      !hasPrBodyTree(prInfo.body)
    )
      continue;
    const body = removePrBodyTrees(prInfo.body ?? '');
    client.pr(['edit', `${prInfo.number}`, '--body-file', '-'], body);
    context.engine.upsertPrInfo(branch, { body });
    context.splog.info(
      `${chalk.green(branch)}: ${
        prInfo.url
      } (removed the legacy dependency tree; GitHub stacks replace it)`
    );
  }
}

function openSubmittedPR(
  args: { view?: boolean; branch: string | undefined },
  context: TContext
): void {
  if (!args.view) return;
  const branchName = args.branch ?? context.engine.currentBranchPrecondition;
  const prInfo = context.engine.getPrInfo(branchName);
  if (!prInfo?.number) return;
  if (context.interactive) {
    GitHubClient.fromConfig(context.repoConfig).pr([
      'view',
      String(prInfo.number),
      '--web',
    ]);
  } else if (prInfo.url) {
    context.splog.info(prInfo.url);
  }
}

async function selectBranches(
  context: TContext,
  branchNames: string[]
): Promise<string[]> {
  const result = [];
  for (const branchName of branchNames) {
    const selected = (
      await context.prompts({
        name: 'value',
        initial: true,
        type: 'confirm',
        message: `Would you like to submit ${chalk.cyan(branchName)}?`,
      })
    ).value;
    // Clear the prompt result
    process.stdout.moveCursor(0, -1);
    process.stdout.clearLine(1);
    if (selected) {
      result.push(branchName);
    }
  }
  return result;
}

async function shouldAbort(
  args: { dryRun: boolean; confirm: boolean; hasAnyPrs: boolean },
  context: TContext
): Promise<boolean> {
  if (args.dryRun) {
    context.splog.info(chalk.blueBright('✅ Dry run complete.'));
    return true;
  }

  if (!args.hasAnyPrs) {
    context.splog.info(
      chalk.blueBright('🆗 All PRs up to date. Checking GitHub stack metadata.')
    );
  }

  if (
    context.interactive &&
    args.confirm &&
    !(
      await context.prompts({
        type: 'confirm',
        name: 'value',
        message: 'Continue with this submit operation?',
        initial: true,
      })
    ).value
  ) {
    context.splog.info(chalk.blueBright('🛑 Aborted submit.'));
    throw new KilledError();
  }

  return false;
}
