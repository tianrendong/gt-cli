import yargs from 'yargs';
import { graphiteWithoutRepo } from '../lib/runner';

export const command = 'guide [title]';
export const canonical = 'guide';
export const aliases = ['g'];
export const description = 'Read extended guides on how to use the gt program.';
export const builder = {
  title: { type: 'string', positional: true, hidden: true },
} as const;

const GUIDES: Record<string, string> = {
  'get-started': [
    'Get started:',
    '  gt init --trunk main          Initialize this repository.',
    '  gt create <name> -am "..."    Create a stacked branch and commit.',
    '  gt modify -a                  Amend the current branch; descendants restack.',
    '  gt submit --stack             Push and create/update PRs and the GitHub Stack.',
    '  gt sync                       Pull trunk, prune merged branches, restack.',
  ].join('\n'),
  navigation: [
    'Navigation:',
    '  gt checkout [branch] | gt up | gt down | gt top | gt bottom',
    '  gt log / gt log short / gt log long   Visualize your stacks.',
    '  gt info [branch]                      Inspect one branch.',
  ].join('\n'),
  collaboration: [
    'Collaboration:',
    '  gt get <branch|pr|stack>     Fetch a stack; new branches arrive frozen.',
    '  gt unfreeze <branch>         Allow local modifications again.',
    '  gt sync                      Fast-forward branches your teammates moved.',
    '  gh stack view                The gh-stack extension sees the same state.',
  ].join('\n'),
  recovery: [
    'Recovery:',
    '  gt continue                  Resume after resolving rebase conflicts.',
    '  gt abort                     Restore the entire interrupted operation.',
    '  gt undo                      Restore the state before the last local gt command.',
  ].join('\n'),
};

export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphiteWithoutRepo(argv, canonical, async (context) => {
    const title = argv.title as string | undefined;
    if (title && GUIDES[title]) {
      context.splog.page(GUIDES[title]);
      return;
    }
    context.splog.page(
      [
        title ? `No guide named ${title}.\n` : '',
        'Available guides (gt guide <title>):',
        ...Object.keys(GUIDES).map((name) => `  ${name}`),
        '',
        Object.values(GUIDES).join('\n\n'),
      ].join('\n')
    );
  });
