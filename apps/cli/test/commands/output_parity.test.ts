import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { OutputCase, runOutputScenarios } from '../lib/output_scenarios';

const cliRoot = path.resolve(__dirname, '../../..');
const reference = JSON.parse(
  fs.readFileSync(
    path.join(cliRoot, 'test/fixtures/native_output.json'),
    'utf8'
  )
) as { nativeVersion: string; cases: OutputCase[] };

describe(`native gt ${reference.nativeVersion} output parity`, function () {
  this.timeout(180000);
  let actual: OutputCase[];
  before(() => {
    actual = runOutputScenarios({
      cli: [process.execPath, path.join(cliRoot, 'dist/src/index.js')],
    });
  });

  it('keeps the native scenario matrix complete', () => {
    expect(actual.map((result) => result.id)).to.deep.equal(
      reference.cases.map((result) => result.id)
    );
  });
  for (const expected of reference.cases) {
    it(expected.id, () => {
      // Do not strip ANSI, trim whitespace, or merge stdout and stderr.
      expect(actual.find((result) => result.id === expected.id)).to.deep.equal(
        expected
      );
    });
  }
});
