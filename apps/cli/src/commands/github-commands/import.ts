import yargs from 'yargs';
import { graphite } from '../../lib/runner';
import {
  importLocalStacks,
  projectStacks,
} from '../../lib/github/local_stacks';
import { ExitFailedError } from '../../lib/errors';

export const command = 'import';
export const description =
  'Resolve a conflict between local gt and gh-stack metadata. Does not rewrite Git commits or contact GitHub.';
export const builder = {
  source: {
    type: 'string',
    choices: ['local', 'gh-stack'],
    demandOption: true,
  },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, 'github import', async (context) => {
    const store = context.githubStacks;
    if (!store) throw new ExitFailedError('No metadata session.');
    if (argv.source === 'local')
      store.file.stacks = projectStacks(context.engine, store.file.stacks);
    else {
      // Explicit user selection replaces the merge base, not Git history.
      store.state.stacks = projectStacks(context.engine);
      importLocalStacks(context, store);
    }
    context.splog.info(
      `Using ${argv.source} topology. Run gt restack if parent changes require rebasing.`
    );
  });
