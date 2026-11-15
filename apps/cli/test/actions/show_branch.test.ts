import { expect } from 'chai';
import stripAnsi from 'strip-ansi';
import { getBranchInfo } from '../../src/actions/show_branch';
import { TContext } from '../../src/lib/context';
import { TEngine } from '../../src/lib/engine/engine';
import {
  TBranchPRInfo,
  TSubmittedVersion,
} from '../../src/lib/engine/metadata_ref';

// Native's legacy importer sometimes supplies a synthetic v1. Our GitHub
// backend must not pretend that a Graphite version exists when it does not.
describe('branch submission display metadata', () => {
  const pr: TBranchPRInfo = {
    number: 1,
    title: 'Change',
    url: 'https://github.com/test/repo/pull/1',
    state: 'OPEN',
  };
  function display(opts: {
    prInfo?: TBranchPRInfo;
    submitted?: TSubmittedVersion;
    revision?: string;
  }): string {
    const engine: Pick<
      TEngine,
      | 'isTrunk'
      | 'getPrInfo'
      | 'getAllCommits'
      | 'isBranchFrozen'
      | 'isBranchFixed'
      | 'getLastSubmittedVersion'
      | 'getRevision'
      | 'getPublishedRevision'
    > = {
      isTrunk: () => false,
      getPrInfo: () => opts.prInfo,
      getAllCommits: () => ['yesterday'],
      isBranchFrozen: () => false,
      isBranchFixed: () => true,
      getLastSubmittedVersion: () => opts.submitted,
      getRevision: () => opts.revision ?? 'head',
      getPublishedRevision: () => opts.submitted?.headSha,
    };
    return stripAnsi(
      getBranchInfo({ branchName: 'feature' }, { engine } as TContext).join(
        '\n'
      )
    );
  }

  it('does not invent a Graphite version for a GitHub-only publication', () => {
    const text = display({ prInfo: pr, submitted: { headSha: 'head' } });
    expect(text).to.contain(
      'PR #1 Change\nhttps://github.com/test/repo/pull/1'
    );
    expect(text).not.to.contain('Last submitted version');
  });

  it('does not print stale version metadata without a PR', () => {
    expect(
      display({ submitted: { headSha: 'head', versionNumber: 3 } })
    ).not.to.contain('Last submitted version');
  });

  it('displays an actual known Graphite version', () => {
    expect(
      display({ prInfo: pr, submitted: { headSha: 'head', versionNumber: 3 } })
    ).to.contain('Last submitted version: v3\n');
  });

  it('marks local changes relative to the published revision', () => {
    expect(
      display({
        prInfo: pr,
        submitted: { headSha: 'old-head', versionNumber: 3 },
      })
    ).to.contain('Last submitted version: v3 (local changes, need submit)');
  });
});
