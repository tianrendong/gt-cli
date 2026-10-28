import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import manifest from '../../src/command_manifest.json';

const dist = path.resolve(__dirname, '../../src');
const scripts = path.resolve(__dirname, '../../../scripts');

describe('lazy command registration', function () {
  this.timeout(120_000);
  let root: string;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-command-loading-'));
    fs.writeFileSync(
      path.join(root, 'user.json'),
      JSON.stringify({ tips: false })
    );
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(mode: 'lazy' | 'eager', args: string[], mock?: string) {
    const trace = path.join(root, 'modules.json');
    const script = `
      const fs = require('fs');
      const commands = require(${JSON.stringify(
        path.join(dist, 'lib/commands.js')
      )});
      if (${JSON.stringify(mode)} === 'eager') {
        commands.registerCommands = parser => parser.commandDir(${JSON.stringify(
          path.join(dist, 'commands')
        )});
      }
      ${
        mock
          ? `
        const file = ${JSON.stringify(
          path.join(dist, 'commands', mock + '.js')
        )};
        const original = require(file);
        require.cache[file].exports = {
          ...original, handler: argv => console.log(JSON.stringify(argv))
        };
      `
          : ''
      }
      process.on('exit', () => fs.writeFileSync(${JSON.stringify(
        trace
      )}, JSON.stringify(Object.keys(require.cache))));
      process.argv = [process.execPath, ${JSON.stringify(
        path.join(dist, 'index.js')
      )}, '--no-interactive', ...${JSON.stringify(args)}];
      require(${JSON.stringify(path.join(dist, 'index.js'))});
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root,
        GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user.json'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'file',
        DEBUG: '',
        FORCE_COLOR: '0',
      },
    });
    expect(result.error).to.equal(undefined);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      modules: JSON.parse(fs.readFileSync(trace, 'utf8')) as string[],
    };
  }
  function matches(args: string[], mock?: string) {
    const { modules: _eager, ...eager } = run('eager', args, mock);
    const { modules: _lazy, ...lazy } = run('lazy', args, mock);
    expect(lazy, args.join(' ')).to.deep.equal(eager);
    if (mock) expect(lazy.status, lazy.stderr).to.equal(0);
  }

  it('keeps generated metadata identical to commandDir registration', () => {
    const { commandManifest } = require(path.join(
      scripts,
      'command-manifest.cjs'
    )) as {
      commandManifest: (directory: string) => unknown;
    };
    expect(
      manifest,
      'Run yarn build to refresh command_manifest.json'
    ).to.deep.equal(commandManifest(path.join(dist, 'commands')));
  });

  it('preserves every top-level help page and alias, including hidden commands', () => {
    const names = new Set(
      manifest.flatMap((entry) => {
        if (!('metadata' in entry) || !entry.metadata) return [];
        const metadata = entry.metadata;
        return [metadata.command, metadata.aliases ?? []]
          .flatMap((name) => (typeof name === 'string' ? [name] : name))
          .map((name) => name.split(' ')[0]);
      })
    );
    for (const name of names) matches([name, '--help']);
  });

  it('preserves root help, completion, errors, capabilities, and nested command help', () => {
    for (const args of [
      [],
      ['--help'],
      ['--version'],
      ['--capabilities'],
      ['not-a-command'],
      ['create', '--not-an-option'],
      ['branch', 'not-a-command'],
      ['branch', 'create', '--help'],
      ['b', 'c', '--help'],
      ['log', 'short', '--help'],
      ['l', 's', '--help'],
      ['stack', 'submit', '--help'],
      ['downstack', 'track', '--help'],
      ['upstack', 'onto', '--help'],
      ['user', 'pager', '--help'],
      ['github', 'sync', '--help'],
      ['completion'],
      ['--get-yargs-completions', 'gt', ''],
    ])
      matches(args);
  });

  it('preserves option defaults, positional parsing, negation, and shorthand expansion', () => {
    const cases: [string, string[]][] = [
      ['create', ['create', 'topic', '-am', 'some message']],
      ['create', ['create', '--update', '--no-verify']],
      ['submit', ['ss', '--stack', '--no-edit', '--branch', 'topic']],
      [
        'modify',
        ['modify', '--into', 'parent', '-m', 'change', '--reset-author'],
      ],
      ['test', ['test', 'printf "hello world"', '--downstack', '--trunk']],
      ['info', ['info', 'topic', '--diff', '--patch']],
    ];
    for (const [mock, args] of cases) matches(args, mock);
  });

  it('does not import action implementations for root help or version', () => {
    for (const args of [['--help'], ['--version']]) {
      const result = run('lazy', args);
      expect(result.status).to.equal(0);
      expect(
        result.modules.filter((file) => file.includes('/src/actions/'))
      ).to.deep.equal([]);
      expect(result.modules).not.to.include(path.join(dist, 'lib/runner.js'));
    }
  });

  it('does not load submit or sync when selecting an unrelated command', () => {
    const result = run('lazy', ['info', '--help']);
    expect(result.status).to.equal(0);
    expect(result.modules).to.include(
      path.join(dist, 'actions/show_branch.js')
    );
    expect(
      result.modules.filter((file) =>
        /\/src\/actions\/(submit|sync)\//.test(file)
      )
    ).to.deep.equal([]);
  });
});
