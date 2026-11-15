import { expect } from 'chai';
import {
  assertTopologyRows,
  nativePrCache,
  Topology,
} from '../../src/lib/switch/plan';
import {
  decodedJSON,
  encodedJSON,
  NativeRow,
} from '../../src/lib/switch/repository';

describe('backend switch partial-stack verification', () => {
  let topology: Topology;
  let rows: NativeRow[];
  let ancestry: Set<string>;
  const isAncestor = (ancestor: string, descendant: string): boolean =>
    ancestry.has(`${ancestor}..${descendant}`);
  const row = (branch: string): NativeRow =>
    rows.find((entry) => entry.branch_name === branch)!;

  beforeEach(() => {
    ancestry = new Set();
    const heads = {
      main: 'a'.repeat(40),
      untracked: 'b'.repeat(40),
      child: 'c'.repeat(40),
      grandchild: 'd'.repeat(40),
    };
    topology = {
      heads,
      metadata: {
        child: {
          parentBranchName: 'untracked',
          parentBranchRevision: heads.untracked,
          lastSubmittedVersion: {
            headSha: heads.child,
            baseName: 'untracked',
            baseSha: heads.untracked,
            versionNumber: 7,
          },
          prInfo: { number: 42, remoteRevision: heads.child },
        },
        grandchild: {
          parentBranchName: 'child',
          parentBranchRevision: heads.child,
        },
      },
      trunks: ['main'],
      frozen: ['child'],
      config: { trunk: 'main' },
    };
    rows = Object.entries(heads).map(([branch, revision]) => {
      const meta = topology.metadata[branch];
      return {
        branch_name: branch,
        parent_branch_name: meta?.parentBranchName ?? null,
        parent_branch_revision: meta?.parentBranchRevision ?? null,
        last_submitted_version: meta?.lastSubmittedVersion
          ? JSON.stringify(meta.lastSubmittedVersion)
          : null,
        state: topology.frozen.includes(branch) ? 'frozen' : null,
        children: null,
        branch_revision: revision,
        validation_result:
          branch === 'main'
            ? 'TRUNK'
            : branch === 'untracked'
            ? 'BAD_PARENT_NAME'
            : branch === 'child'
            ? 'INVALID_PARENT'
            : 'VALID',
        parent_head_revision: meta?.parentBranchName
          ? topology.heads[meta.parentBranchName]
          : null,
      };
    });
  });

  for (const validation of ['VALID', 'INVALID_PARENT']) {
    it(`preserves native ${validation} descendants below an untracked ancestor`, () => {
      row('grandchild').validation_result = validation;
      expect(() =>
        assertTopologyRows(topology, rows, isAncestor)
      ).not.to.throw();
    });
  }

  for (const validation of [
    null,
    'BAD_PARENT_NAME',
    'BAD_PARENT_REVISION',
    'UNKNOWN',
  ]) {
    it(`rejects ${validation} even below an untracked ancestor`, () => {
      row('child').validation_result = validation;
      expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
        'Native Graphite validation disagrees for child'
      );
    });
  }

  const trackRoot = (parent: string): void => {
    const base = topology.heads[parent];
    topology.metadata.untracked = {
      parentBranchName: parent,
      parentBranchRevision: base,
    };
    Object.assign(row('untracked'), {
      parent_branch_name: parent,
      parent_branch_revision: base,
      validation_result: 'VALID',
    });
  };

  it('does not accept INVALID_PARENT when ancestry reaches a configured trunk', () => {
    trackRoot('main');
    expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
      'Native Graphite validation disagrees for child'
    );
  });

  it('does not treat a missing parent head as an untracked boundary', () => {
    delete topology.heads.untracked;
    expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
      'Native Graphite validation disagrees for child'
    );
  });

  it('does not treat a cycle as an untracked boundary', () => {
    trackRoot('child');
    expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
      'Native Graphite validation disagrees for child'
    );
  });

  const conflicts: Partial<NativeRow> = {
    parent_branch_name: 'main',
    parent_branch_revision: 'f'.repeat(40),
    branch_revision: 'f'.repeat(40),
    last_submitted_version: '{"headSha":"unexpected"}',
    state: null,
  };
  for (const [column, value] of Object.entries(conflicts)) {
    it(`still compares ${column} exactly for partial stacks`, () => {
      Object.assign(row('child'), { [column]: value });
      expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
        'Graphite round-trip verification failed for child'
      );
    });
  }

  describe('forward-repaired parent revision', () => {
    const stale = 'e'.repeat(40);
    beforeEach(() => {
      topology.metadata.grandchild.parentBranchRevision = stale;
      ancestry = new Set([
        `${stale}..${topology.heads.child}`,
        `${topology.heads.child}..${topology.heads.grandchild}`,
      ]);
    });

    it('accepts the parent head when the stored base is its ancestor', () => {
      expect(() =>
        assertTopologyRows(topology, rows, isAncestor)
      ).not.to.throw();
    });

    it('rejects the parent head when the stored base is not its ancestor', () => {
      ancestry.delete(`${stale}..${topology.heads.child}`);
      expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
        'Graphite round-trip verification failed for grandchild'
      );
    });

    it('rejects the parent head when it is not an ancestor of the branch', () => {
      ancestry.delete(`${topology.heads.child}..${topology.heads.grandchild}`);
      expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
        'Graphite round-trip verification failed for grandchild'
      );
    });
  });

  it('does not allow native validation to silently track the untracked parent', () => {
    row('untracked').parent_branch_name = 'main';
    expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
      'Graphite unexpectedly tracked untracked'
    );
  });

  it('does not allow native validation to drop a child', () => {
    rows = rows.filter((entry) => entry.branch_name !== 'child');
    expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
      'Graphite round-trip verification failed for child'
    );
  });

  it('does not allow native validation to lose a configured trunk', () => {
    row('main').validation_result = 'BAD_PARENT_NAME';
    expect(() => assertTopologyRows(topology, rows, isAncestor)).to.throw(
      'Graphite did not recognize trunk main'
    );
  });

  const cache = (previous?: string) => {
    const input = encodedJSON({
      prInfos: [
        {
          prNumber: 42,
          headRefName: 'child',
          cliTrunk: previous,
          opaque: 'keep',
        },
      ],
      mergeabilityStatuses: [],
    });
    return decodedJSON<{ prInfos: Array<Record<string, unknown>> }>(
      nativePrCache(topology, input),
      { prInfos: [] }
    ).prInfos[0];
  };

  it('preserves cached trunk identity instead of naming an untracked ancestor as trunk', () => {
    expect(cache('main')).to.include({ cliTrunk: 'main', opaque: 'keep' });
  });

  it('does not invent a trunk when a partial stack has no cached trunk identity', () => {
    expect(cache()).not.to.have.property('cliTrunk');
  });

  it('still updates the cached trunk when ancestry reaches a configured trunk', () => {
    trackRoot('main');
    expect(cache('old-trunk').cliTrunk).to.equal('main');
  });
});
