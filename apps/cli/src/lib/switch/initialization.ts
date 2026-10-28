import fs from 'fs';
import path from 'path';
import { Repository, fail } from './repository';
import { expandCommand } from '../pre-yargs/preprocess_command';

export const INITIALIZATION_REQUIRED =
  'This repository is not initialized. Run gt init --trunk <branch> first.';

/** Configuration is enrollment; selecting an executable or finding a DB is not. */
export function repositoryInitialized(repo: Repository): boolean {
  const file = path.join(repo.common, '.graphite_repo_config');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink())
    fail('Unsafe repository configuration. No initialization was inferred.');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config))
    fail('Invalid repository configuration. No initialization was inferred.');
  return typeof config.trunk === 'string' && config.trunk.length > 0;
}

/** Match the same first-command alias expansion as yargs, never later operands. */
export function initializationRequested(options: string[]): boolean {
  const globals = new Set([
    '--interactive',
    '--no-interactive',
    '--quiet',
    '--no-quiet',
    '-q',
    '--verify',
    '--no-verify',
    '--debug',
    '--no-debug',
  ]);
  let index = 0;
  while (index < options.length && globals.has(options[index].split('=')[0]))
    index++;
  if (!options[index]) return false;
  const command = [
    ...expandCommand(options[index], options[index + 1]),
    ...options.slice(index + 1),
  ];
  return (
    command[0] === 'init' ||
    (command[0] === 'repo' && ['init', 'i'].includes(command[1]))
  );
}
