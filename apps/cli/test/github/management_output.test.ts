import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import stripAnsi from 'strip-ansi';

const cli = path.resolve(__dirname, '../../..');
const output = path.join(cli, 'scripts/installation/output.cjs');
const shell = path.join(cli, 'scripts/installation/output.sh');
const entry = path.join(cli, 'bin/gt-cli');
const settings = path.resolve(__dirname, '../../src/settings_cli.js');
const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  NO_COLOR: undefined,
  NODE_DISABLE_COLORS: undefined,
  FORCE_COLOR: undefined,
  TERM: 'xterm-256color',
  ...overrides,
});
const render = (
  body: string,
  env: NodeJS.ProcessEnv = {},
  terminals: number[] = []
) =>
  spawnSync(
    process.execPath,
    [
      '-e',
      `require('tty').isatty = fd => ${JSON.stringify(terminals)}.includes(fd);
       const output = require(${JSON.stringify(output)});
       ${body}`,
    ],
    { encoding: 'utf8', env: environment(env) }
  );
const messages = `console.log(output.color('stdout', 'green', 'Success'));
  console.error(output.color('stderr', 'red', 'ERROR: failure'));`;

describe('compact management output', function () {
  this.timeout(20_000);

  it('uses a small palette without changing text or blank lines', () => {
    const result = render(
      `for (const style of ['bold', 'dim', 'red', 'green', 'yellow', 'cyan'])
         console.log(output.color('stdout', style, style));
       console.log(output.color('stdout', 'cyan', ${JSON.stringify(
         'First\n\nLast'
       )}));`,
      {},
      [1]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal(
      '\u001b[1mbold\u001b[22m\n' +
        '\u001b[2mdim\u001b[22m\n' +
        '\u001b[31mred\u001b[39m\n' +
        '\u001b[32mgreen\u001b[39m\n' +
        '\u001b[33myellow\u001b[39m\n' +
        '\u001b[36mcyan\u001b[39m\n' +
        '\u001b[36mFirst\u001b[39m\n\n\u001b[36mLast\u001b[39m\n'
    );
  });

  it('detects stdout and stderr terminals independently', () => {
    const stderr = render(messages, {}, [2]);
    expect(stderr.stdout).to.equal('Success\n');
    expect(stderr.stderr).to.equal('\u001b[31mERROR: failure\u001b[39m\n');
    const stdout = render(messages, {}, [1]);
    expect(stdout.stdout).to.equal('\u001b[32mSuccess\u001b[39m\n');
    expect(stdout.stderr).to.equal('ERROR: failure\n');
  });

  it('keeps pipes plain and honors explicit opt-outs on terminals', () => {
    expect(render(messages).stdout).to.equal('Success\n');
    for (const env of [
      { FORCE_COLOR: '0' },
      { FORCE_COLOR: 'false' },
      { TERM: 'dumb' },
      { NO_COLOR: '' },
      { NO_COLOR: '1', FORCE_COLOR: '1' },
      { NO_COLOR: '', FORCE_COLOR: '1' },
      { NODE_DISABLE_COLORS: '1', FORCE_COLOR: '1' },
    ]) {
      const result = render(messages, env, [1, 2]);
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout + result.stderr).not.to.contain('\u001b[');
    }
  });

  it('uses the same palette and color overrides before Node is available', () => {
    for (const env of [
      {},
      { FORCE_COLOR: '1' },
      { FORCE_COLOR: '' },
      { FORCE_COLOR: 'true', TERM: 'dumb' },
      { FORCE_COLOR: '0' },
      { FORCE_COLOR: 'false' },
      { NO_COLOR: '', FORCE_COLOR: '1' },
      { NO_COLOR: '1', FORCE_COLOR: '1' },
      { NODE_DISABLE_COLORS: '1', FORCE_COLOR: '1' },
    ]) {
      const node = render(messages, env);
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          '. "$1"; gt_cli_print 1 green Success; gt_cli_print 2 red "ERROR: failure" >&2',
          'sh',
          shell,
        ],
        { encoding: 'utf8', env: environment(env) }
      );
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.equal(node.stdout);
      expect(result.stderr).to.equal(node.stderr);
    }
  });

  it('colors help and unknown-command errors without starting Node', () => {
    const env = environment({ FORCE_COLOR: '1', PATH: '/usr/bin:/bin' });
    const help = spawnSync(entry, ['--help'], { env, encoding: 'utf8' });
    expect(help.status, help.stderr).to.equal(0);
    expect(help.stdout).to.contain('\u001b[36mgt-cli update\u001b[39m');
    expect(help.stdout).to.contain('\u001b[2mStack commands stay gt.');
    expect(stripAnsi(help.stdout).trim().split('\n')).to.have.length(8);
    const invalid = spawnSync(entry, ['log'], { env, encoding: 'utf8' });
    expect(invalid.status).to.equal(1);
    expect(invalid.stdout).to.equal('');
    expect(invalid.stderr).to.equal(
      '\u001b[31mUnknown management command: log. Use gt for stack commands.\u001b[39m\n'
    );
  });

  it('colors diagnostic headings without coloring recovery paragraphs', () => {
    const result = render(
      `console.error(output.diagnostic('stderr', 'red', ${JSON.stringify(
        'ERROR: failed\nFix the issue.\n\nKeep backups.'
      )}));`,
      { FORCE_COLOR: '1' }
    );
    expect(result.stderr).to.equal(
      '\u001b[31mERROR: failed\u001b[39m\nFix the issue.\n\nKeep backups.\n'
    );
  });

  describe('settings', () => {
    let root: string, repo: string, env: NodeJS.ProcessEnv;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-management-output-'));
      repo = path.join(root, 'repo');
      fs.mkdirSync(repo);
      env = environment({
        FORCE_COLOR: '1',
        HOME: root,
        GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: undefined,
      });
      execFileSync('git', ['init', '-b', 'main'], {
        cwd: repo,
        env,
        stdio: 'ignore',
      });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = (args: string[]) =>
      spawnSync(process.execPath, [settings, ...args], {
        cwd: repo,
        env,
        encoding: 'utf8',
      });

    it('keeps repository status to one line, with neutral disabled settings', () => {
      const enabled = run(['graphite', 'enable']);
      expect(enabled.status, enabled.stderr).to.equal(0);
      expect(enabled.stdout).to.equal(
        'Graphite submission: \u001b[32menabled\u001b[39m \u001b[2m(repository override).\u001b[22m\n'
      );
      const disabled = run(['graphite', 'disable']);
      expect(disabled.stdout).to.equal(
        'Graphite submission: \u001b[1mdisabled\u001b[22m \u001b[2m(repository override).\u001b[22m\n'
      );
      expect(run(['graphite', 'status']).stdout).to.equal(disabled.stdout);
      const inherited = run(['graphite', 'reset']);
      expect(stripAnsi(inherited.stdout)).to.equal(
        'Graphite submission: disabled (built-in default).\n'
      );
      expect(fs.existsSync(path.join(repo, '.git/gt-gh-switch'))).to.equal(
        false
      );
    });

    it('colors config values and help commands, retaining scope information', () => {
      const value = run(['config', 'submit.graphite', 'true']);
      expect(value.stdout).to.equal(
        'submit.graphite=\u001b[32mtrue\u001b[39m \u001b[2m(repository)\u001b[22m\n'
      );
      const help = run(['graphite', '--help']);
      expect(help.stdout).to.contain('\u001b[36mgt-cli graphite');
      expect(help.stdout).to.contain('\u001b[36m--global\u001b[39m');
    });

    it('keeps JSON and JSON-mode errors ANSI-free even when colors are forced', () => {
      const result = run(['graphite', 'enable', '--json']);
      expect(result.status, result.stderr).to.equal(0);
      expect(JSON.parse(result.stdout)).to.deep.equal({
        key: 'submit.graphite',
        scope: 'repository',
        value: true,
        enabled: true,
        source: 'repository',
      });
      expect(result.stdout + result.stderr).not.to.contain('\u001b[');
      const invalid = run(['graphite', 'invalid', '--json']);
      expect(invalid.status).to.equal(1);
      expect(invalid.stdout + invalid.stderr).not.to.contain('\u001b[');
      expect(run(['graphite', '--help', '--json']).stdout).not.to.contain(
        '\u001b['
      );
    });

    it('uses red for errors and preserves plain output under NO_COLOR', () => {
      const invalid = run(['config', 'submit.graphite', 'yes']);
      expect(invalid.status).to.equal(1);
      expect(invalid.stdout).to.equal('');
      expect(invalid.stderr).to.contain('\u001b[31mERROR:');
      env.NO_COLOR = '';
      const plain = run(['config', 'submit.graphite', 'yes']);
      expect(plain.stderr).to.equal(stripAnsi(invalid.stderr));
      expect(run(['graphite', 'status']).stdout).to.equal(
        'Graphite submission: disabled (built-in default).\n'
      );
    });
  });
});
