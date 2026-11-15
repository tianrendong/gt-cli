import yargs from 'yargs';
import { graphite } from '../../lib/runner';

const args = {
  branch: {
    type: 'string',
    required: true,
    positional: true,
  },
  title: {
    type: 'string',
  },
  body: {
    type: 'string',
  },
} as const;

export const command = 'metaedit [branch]';
export const canonical = 'internal-only metaedit';
export const description = false;
export const builder = args;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;
export const handler = async (argv: argsT): Promise<void> => {
  return graphite(argv, canonical, async (context) => {
    context.engine.upsertPrInfo(argv.branch, {
      title: argv.title,
      body: argv.body,
    });
  });
};
