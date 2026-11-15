#!/usr/bin/env node
/** Offline presentation parity. All mutations happen in disposable repositories.
 * Build first. Native Graphite is needed only for live comparison/recording.
 * node scripts/parity/output.cjs [--graphite /absolute/path/to/native/gt]
 * node scripts/parity/output.cjs --graphite /path/to/gt --record /path/to/snapshot.json
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const { runOutputScenarios } = require(path.resolve(
  __dirname,
  '../../dist/test/lib/output_scenarios.js'
));

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith('--'))
    throw new Error(`Missing value for ${name}`);
  return path.resolve(args[at + 1]);
};
const native = option('--graphite');
const record = option('--record');
const fixture = path.resolve(
  __dirname,
  '../../test/fixtures/native_output.json'
);
if (record && !native)
  throw new Error(
    '--record requires --graphite. Never record our implementation as the reference.'
  );

const progress = (name) => {
  let count = 0;
  return () => {
    if (++count % 10 === 0)
      console.log(`${name}: ${count} scenarios completed`);
  };
};
let reference;
if (native) {
  const version = spawnSync(native, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, GT_GH_PROBING_NATIVE: '1' },
  });
  if (version.error) throw version.error;
  assert.equal(version.status, 0, version.stderr);
  assert.equal(
    version.stdout.trim(),
    '1.8.6',
    'This baseline targets native Graphite 1.8.6. Review version changes explicitly.'
  );
  reference = {
    nativeVersion: version.stdout.trim(),
    cases: runOutputScenarios({
      cli: [native],
      native: true,
      onCase: progress('native'),
    }),
  };
} else {
  reference = JSON.parse(fs.readFileSync(fixture, 'utf8'));
}
if (record) {
  fs.writeFileSync(record, JSON.stringify(reference, null, 2) + '\n');
  console.log(
    `Recorded ${reference.cases.length} native scenarios in ${record}`
  );
} else {
  const actual = runOutputScenarios({
    cli: [process.execPath, path.resolve(__dirname, '../../dist/src/index.js')],
    onCase: progress('candidate'),
  });
  assert.deepEqual(
    actual.map((result) => result.id),
    reference.cases.map((result) => result.id),
    'Scenario matrix differs; explicitly re-record native baseline.'
  );
  let failed = 0;
  for (let i = 0; i < actual.length; i++) {
    if (isDeepStrictEqual(actual[i], reference.cases[i])) continue;
    failed++;
    console.error(
      `\nDIFF ${actual[i].id}\nnative: ${JSON.stringify(
        reference.cases[i]
      )}\nours:   ${JSON.stringify(actual[i])}`
    );
  }
  console.log(
    `${actual.length - failed}/${
      actual.length
    } output scenarios match native Graphite ${
      reference.nativeVersion
    } (ANSI, whitespace, stdout, stderr, exit status).`
  );
  process.exitCode = failed ? 1 : 0;
}
