import yargs from 'yargs';
import { graphite } from '../../lib/runner';

const args = {
  'config-name': {
    demandOption: true,
    type: 'string',
    positional: true,
    describe: 'The config to load.',
  },
  'config-value': {
    demandOption: true,
    type: 'string',
    positional: true,
    describe: 'The new value for that config.',
  },
  level: {
    type: 'string',
    describe: 'Where to apply the config, right now only user is respected.',
  },
} as const;

export const command = 'set-config [config-name] [config-value]';
export const canonical = 'internal-only set-config';
export const description = false;
export const builder = args;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;
export const handler = async (argv: argsT): Promise<void> => {
  return graphite(argv, canonical, async (context) => {
    context.userConfig.update((data) => {
      data.gtiConfigs = [
        ...(data.gtiConfigs || []).filter(
          (config) => config.key !== argv['config-name']
        ),
        {
          key: argv['config-name'],
          value: argv['config-value'],
        },
      ];
    });
  });
};
