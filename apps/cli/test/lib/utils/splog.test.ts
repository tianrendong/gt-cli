import chalk from 'chalk';
import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { version } from '../../../package.json';
import { composeSplog } from '../../../src/lib/utils/splog';
import { tracer } from '../../../src/lib/utils/tracer';

describe('native-style output streams and paging', () => {
  let stdout: string[];
  let stderr: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalLevel: typeof chalk.level;
  let tty: PropertyDescriptor | undefined;
  let directory: string;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => stdout.push(args.join(' '));
    console.error = (...args: unknown[]) => stderr.push(args.join(' '));
    originalLevel = chalk.level;
    chalk.level = 3;
    tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-output-unit-'));
  });
  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    chalk.level = originalLevel;
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const terminal = (isTTY: boolean) => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: isTTY,
      configurable: true,
    });
  };

  it('keeps normal output and explicit newlines on stdout', () => {
    const log = composeSplog();
    log.info('branch');
    log.newline();
    log.info('');
    expect(stdout).to.deep.equal(['branch', '', '']);
    expect(stderr).to.deep.equal([]);
  });

  for (const quiet of [false, true]) {
    it(`keeps errors and warnings on stderr (quiet=${quiet})`, () => {
      const log = composeSplog({ quiet });
      log.error('failure');
      log.warn('warning');
      expect(stdout).to.deep.equal([]);
      expect(stderr).to.deep.equal([
        '\x1b[91mERROR: failure \x1b[39m',
        '\x1b[33mWARNING: warning\x1b[39m',
      ]);
    });
  }

  it('preserves multiline diagnostic coloring', () => {
    composeSplog().error('first\nsecond');
    expect(stderr).to.deep.equal([
      '\x1b[91mERROR: first\x1b[39m\n\x1b[91msecond \x1b[39m',
    ]);
  });

  it('does not add ANSI when color support is disabled', () => {
    chalk.level = 0;
    const log = composeSplog();
    log.error('failure');
    log.warn('warning');
    expect(stderr).to.deep.equal(['ERROR: failure ', 'WARNING: warning']);
  });

  it('prints enabled tips dimmed on stderr, without legacy boilerplate', () => {
    composeSplog({ tips: true }).tip('Use gt restack.');
    expect(stdout).to.deep.equal([]);
    expect(stderr).to.deep.equal([
      '\x1b[2m\x1b[22m\n' +
        '\x1b[2m\x1b[33mtip\x1b[39m: Use gt restack.\x1b[22m\n' +
        '\x1b[2m\x1b[22m',
    ]);
  });

  it('does not print disabled tips', () => {
    composeSplog().tip('hidden');
    composeSplog({ tips: false }).tip('hidden');
    expect(stdout).to.deep.equal([]);
    expect(stderr).to.deep.equal([]);
  });

  it('quiet suppresses info, newlines, tips, and pages before starting a pager', () => {
    terminal(true);
    const log = composeSplog({ quiet: true, tips: true, pager: 'exit 99' });
    log.info('hidden');
    log.newline();
    log.tip('hidden');
    log.page('hidden');
    expect(stdout).to.deep.equal([]);
    expect(stderr).to.deep.equal([]);
  });

  it('prints directly when no pager is configured, piped or on a terminal', () => {
    for (const isTTY of [true, false]) {
      terminal(isTTY);
      composeSplog().page('page');
    }
    expect(stdout).to.deep.equal(['page', 'page']);
    expect(stderr).to.deep.equal([]);
  });

  // Native pages whenever interactive features are on, even piped; the context
  // decides interactivity and only then supplies a pager.
  it('passes ANSI and exact whitespace to a configured pager, even piped', () => {
    terminal(false);
    const output = path.join(directory, 'page.json');
    const script = path.join(directory, 'pager.cjs');
    fs.writeFileSync(
      script,
      `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(
        output
      )}, JSON.stringify({ input: fs.readFileSync(0, 'utf8'), less: process.env.LESS, lv: process.env.LV }));`
    );
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const text = '\x1b[36mbranch\x1b[39m\n  \n';
    composeSplog({ pager: `${quote(process.execPath)} ${quote(script)}` }).page(
      text
    );
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).to.deep.equal({
      input: text,
      less: process.env.LESS ?? 'FRX',
      lv: process.env.LV ?? '-c',
    });
    expect(stdout).to.deep.equal([]);
    expect(stderr).to.deep.equal([]);
  });

  it('keeps pager failures out of stdout diagnostics', () => {
    terminal(true);
    expect(() => composeSplog({ pager: 'exit 2' }).page('page')).to.throw();
    expect(stdout).to.deep.equal(['page']);
    expect(stderr).to.have.length(1);
    expect(stderr[0]).to.contain(
      'WARNING: Tried to send output to your pager'
    );
  });

  it('emits structured, uncolored debug records only when requested', () => {
    composeSplog().debug('hidden');
    expect(stdout).to.deep.equal([]);
    composeSplog({ outputDebugLogs: true }).debug('line one\nline two');
    expect(stdout).to.have.length(1);
    expect(stdout[0]).not.to.contain('\x1b[');
    const record = JSON.parse(stdout[0]);
    expect(record).to.deep.equal({
      cliVersion: version,
      level: 'debug',
      message: 'line one\nline two',
      timestamp: record.timestamp,
      traceId: tracer.traceId,
    });
    expect(new Date(record.timestamp).toISOString()).to.equal(record.timestamp);
    expect(stderr).to.deep.equal([]);
  });
});
