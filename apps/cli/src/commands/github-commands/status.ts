import yargs from 'yargs';
import { graphite } from '../../lib/runner';
import { projectStacks } from '../../lib/github/local_stacks';
import { StackStore } from '../../lib/github/stack_file';
import { githubStackAPI, listRemoteStacks } from '../../lib/github/stack_sync';

export const command = 'status';
export const description =
  'Show gt topology, the gh-stack mirror, and optionally GitHub topology without changing them.';
export const builder = {
  json: { type: 'boolean', default: false },
  remote: {
    type: 'boolean',
    default: false,
    describe: 'Read native stacks from GitHub.',
  },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, 'github status', async (context) => {
    // Another command holds the lock: inspect the mirror as it is right now.
    const store = context.githubStacks ?? StackStore.snapshot();
    const remote = argv.remote
      ? await listRemoteStacks(githubStackAPI(context))
      : undefined;
    const value = {
      local: projectStacks(context.engine),
      ghStack: store.file,
      ...(remote ? { remote } : {}),
    };
    if (argv.json) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    else {
      for (const stack of value.local) {
        context.splog.info(
          `${stack.trunk.branch} <- ${stack.branches
            .map((b) => b.branch)
            .join(' <- ')}`
        );
      }
      context.splog.info(`Mirror: ${store.filePath}`);
      if (value.remote)
        context.splog.info(`GitHub: ${value.remote.length} stack(s).`);
    }
  });
