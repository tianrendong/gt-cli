import type { Argv, CommandModule } from 'yargs';
import manifest from '../command_manifest.json';

type Entry = {
  file: string;
  eager?: boolean;
  metadata?: Pick<
    CommandModule,
    'command' | 'aliases' | 'describe' | 'deprecated'
  > & { description?: string | false; desc?: string | false };
};

/** Register help and aliases without importing every action and its dependencies.
 * The generated manifest contains no builders or handlers: load the original
 * module when yargs selects it, preserving live defaults and nested commandDir
 * resolution. Completion and other opaque registrations remain eager.
 */
export function registerCommands(parser: Argv): Argv {
  for (const entry of manifest as Entry[]) {
    let command: CommandModule | undefined;
    const load = (): CommandModule =>
      // Like commandDir, preserve synchronous builder/completion semantics.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (command ??= require(`../commands/${entry.file}`) as CommandModule);
    if (entry.eager) {
      parser.command(load());
      continue;
    }
    parser.command({
      ...entry.metadata,
      builder: (inner: Argv, helpOrVersionSet?: boolean) => {
        const builder = load().builder;
        if (typeof builder !== 'function') return inner.options(builder ?? {});
        // yargs 17 passes this flag although our older @types omit it.
        return (builder as (parser: Argv, help?: boolean) => Argv)(
          inner,
          helpOrVersionSet
        );
      },
      handler: (argv) => load().handler?.(argv),
    });
  }
  return parser;
}
