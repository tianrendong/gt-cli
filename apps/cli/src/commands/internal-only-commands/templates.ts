import yargs from 'yargs';
import { graphite } from '../../lib/runner';
import { getPRTemplateFilepaths } from '../../lib/utils/pr_templates';
import fs from 'fs';

const args = {} as const;

export const command = 'templates';
export const canonical = 'internal-only templates';
export const description = false;
export const builder = args;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;
export const handler = async (argv: argsT): Promise<void> => {
  return graphite(argv, canonical, async (context) => {
    const templateFiles = getPRTemplateFilepaths();

    context.splog.info(
      JSON.stringify(
        Object.fromEntries(
          templateFiles.map((templateFile) => {
            return [templateFile, fs.readFileSync(templateFile).toString()];
          })
        )
      )
    );
  });
};
