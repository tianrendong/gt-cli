#!/usr/bin/env node
/* eslint-disable no-console */
import path from 'path';
import { color, diagnostic, help } from '../scripts/installation/output.cjs';
import {
  graphiteSubmitSetting,
  readGraphiteSubmit,
  writeGraphiteSubmit,
} from './lib/graphite_cloud/settings';

const HELP = `gt-cli config submit.graphite [true|false] [--global | --repo PATH]
gt-cli config submit.graphite --unset [--global | --repo PATH]

Default: false. Repository values override the global default.
Omit a value to inspect; omit scope to use the current repository.
--unset removes the selected override. --json prints machine-readable output.
Graphite mirroring requires native Graphite authentication or GT_GRAPHITE_TOKEN.`;

const GRAPHITE_HELP = `gt-cli graphite <enable|disable|status|reset> [--global | --repo PATH]

Enable or disable Graphite submission; status shows the effective setting.
Default scope: current repository, shared with its linked worktrees.
--global changes the default; repository overrides always take precedence.
reset removes the selected override; repositories then inherit the global default.
--json prints machine-readable output. The existing config command still works.
These commands do not submit, authenticate, or change the CLI backend.
GitHub submission is unchanged. Graphite submission is off by default.`;

const args = process.argv.slice(2);
const json = args.includes('--json');
try {
  const graphite = args[0] === 'graphite';
  if (graphite || args[0] === 'config') args.shift();
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    const text = graphite ? GRAPHITE_HELP : HELP;
    console.log(json ? text : help(text));
  } else {
    let global = false,
      unset = false,
      repo: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--global') global = true;
      else if (arg === '--unset' && !graphite) unset = true;
      else if (arg === '--json') continue;
      else if (arg === '--repo') {
        if (!args[i + 1] || args[i + 1].startsWith('--'))
          throw Error('Missing --repo path.');
        repo = path.resolve(args[++i]);
      } else if (arg.startsWith('-'))
        throw Error(
          `Unsupported ${graphite ? 'graphite' : 'config'} argument: ${arg}`
        );
      else positional.push(arg);
    }
    if (global && repo) throw Error('Choose --global or --repo, not both.');
    if (graphite) {
      if (
        positional.length !== 1 ||
        !['enable', 'disable', 'status', 'reset'].includes(positional[0])
      )
        throw Error(
          'Use gt-cli graphite <enable|disable|status|reset> [--global | --repo PATH].'
        );
      const action = positional.pop();
      positional.push('submit.graphite');
      if (action === 'enable' || action === 'disable')
        positional.push(String(action === 'enable'));
      unset = action === 'reset';
    }
    if (
      positional[0] !== 'submit.graphite' ||
      positional.length > 2 ||
      (unset && positional.length === 2) ||
      (positional.length === 2 && !['true', 'false'].includes(positional[1]))
    )
      throw Error(
        'Use gt-cli config submit.graphite [true|false] [--global | --repo PATH], or --unset.'
      );
    const scope = global ? 'global' : 'local';
    if (unset || positional.length === 2)
      writeGraphiteSubmit(
        unset ? undefined : positional[1] === 'true',
        scope,
        repo
      );
    const stored = readGraphiteSubmit(scope, repo);
    const effective = global
      ? {
          enabled: stored ?? false,
          source: stored === undefined ? 'default' : 'global',
        }
      : graphiteSubmitSetting(repo);
    const output = {
      key: 'submit.graphite',
      scope: global ? 'global' : 'repository',
      value: stored ?? null,
      ...effective,
    };
    console.log(
      json
        ? JSON.stringify(output)
        : graphite
        ? `Graphite submission: ${color(
            'stdout',
            effective.enabled ? 'green' : 'bold',
            effective.enabled ? 'enabled' : 'disabled'
          )} ${color(
            'stdout',
            'dim',
            `(${
              effective.source === 'repository'
                ? 'repository override'
                : effective.source === 'global'
                ? 'global default'
                : 'built-in default'
            }).`
          )}${
            global
              ? '\nRepository overrides take precedence over this global default.'
              : ''
          }`
        : `submit.graphite=${color(
            'stdout',
            effective.enabled ? 'green' : 'bold',
            String(effective.enabled)
          )} ${color(
            'stdout',
            'dim',
            `(${effective.source}${
              stored === undefined ? '; no override' : ''
            })`
          )}`
    );
  }
} catch (error) {
  const message = `ERROR: ${error.message}`;
  console.error(json ? message : diagnostic('stderr', 'red', message));
  process.exitCode = 1;
}
