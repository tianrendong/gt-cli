import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MirrorState,
  mergeLegacyStates,
  recordMatches,
  SHARED_STATE_DIRECTORY,
  StackStore,
} from '../../src/lib/github/stack_file';

/** Repository-wide GitHub stack records (one file per stack in the common Git
 * directory). Uses plain directories laid out like Git's: the common directory
 * doubles as the main worktree's Git directory; linked worktrees live under
 * worktrees/<name>. */
describe('shared GitHub stack records', function () {
  this.timeout(20_000);
  let common: string, linkedA: string, linkedB: string;
  const shared = (...parts: string[]) =>
    path.join(common, SHARED_STATE_DIRECTORY, ...parts);
  const record = (number: number) =>
    JSON.parse(fs.readFileSync(shared('remote', `${number}.json`), 'utf8'));
  const legacy = (directory: string, state: Partial<MirrorState>) =>
    fs.writeFileSync(
      path.join(directory, 'gt-github-sync'),
      JSON.stringify({ version: 1, stacks: [], remote: {}, ...state })
    );
  const legacyState = (directory: string): MirrorState =>
    JSON.parse(fs.readFileSync(path.join(directory, 'gt-github-sync'), 'utf8'));
  const withStore = <T>(
    directory: string,
    action: (store: StackStore) => T
  ): T => {
    const store = new StackStore(directory, common);
    try {
      return action(store);
    } finally {
      store.close();
    }
  };

  beforeEach(() => {
    common = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shared-records-'));
    linkedA = path.join(common, 'worktrees', 'a');
    linkedB = path.join(common, 'worktrees', 'b');
    for (const [directory, checkout] of [
      [linkedA, '/work/a'],
      [linkedB, '/work/b'],
    ]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'gitdir'), `${checkout}/.git\n`);
    }
  });
  afterEach(() => fs.rmSync(common, { recursive: true, force: true }));

  it('shows a record written in one worktree to every other worktree', () => {
    withStore(linkedA, (store) => {
      store.state.remote['7'] = { base: 'main', prs: [1, 2] };
      store.save();
    });
    withStore(linkedB, (store) => {
      expect(store.state.remote['7']).to.include({ base: 'main' });
      expect(store.state.remote['7'].prs).to.deep.equal([1, 2]);
      expect(store.state.remote['7'].writtenBy).to.equal('/work/a');
      expect(Date.parse(store.state.remote['7'].at ?? '')).to.be.a('number');
    });
    withStore(common, (store) =>
      expect(store.state.remote['7'].prs).to.deep.equal([1, 2])
    );
  });

  it('writes only the stacks a process changed, so writers of other stacks never collide', () => {
    const a = new StackStore(linkedA, common);
    const b = new StackStore(linkedB, common);
    try {
      // Both loaded before either wrote; neither waits for the other.
      a.state.remote['1'] = { base: 'main', prs: [1, 2] };
      b.state.remote['2'] = { base: 'main', prs: [3, 4] };
      b.save();
      a.save();
    } finally {
      a.close();
      b.close();
    }
    expect(record(1).prs).to.deep.equal([1, 2]);
    expect(record(2).prs).to.deep.equal([3, 4]);
    expect(record(2).writtenBy).to.equal('/work/b');
    withStore(common, (store) =>
      expect(Object.keys(store.state.remote).sort()).to.deep.equal(['1', '2'])
    );
  });

  it('lets the last writer of the same stack win without corrupting the file', () => {
    const a = new StackStore(linkedA, common);
    const b = new StackStore(linkedB, common);
    try {
      a.state.remote['5'] = { base: 'main', prs: [1, 2, 3] };
      b.state.remote['5'] = { base: 'main', prs: [1, 2] };
      a.save();
      b.save();
    } finally {
      a.close();
      b.close();
    }
    // Behind GitHub ([1, 2, 3]): the next submit must refuse, not overwrite.
    expect(record(5).prs).to.deep.equal([1, 2]);
    withStore(linkedA, (store) =>
      expect(
        recordMatches(store.state.remote['5'], 'main', [1, 2, 3])
      ).to.equal(false)
    );
  });

  it('deletes a pruned record and keeps unrelated ones', () => {
    withStore(linkedA, (store) => {
      store.state.remote['1'] = { base: 'main', prs: [1, 2] };
      store.state.remote['2'] = { base: 'main', prs: [3, 4] };
      store.save();
    });
    withStore(linkedB, (store) => {
      delete store.state.remote['1'];
      store.save();
    });
    expect(fs.existsSync(shared('remote', '1.json'))).to.equal(false);
    expect(record(2).prs).to.deep.equal([3, 4]);
  });

  it('keeps writing the per-worktree file in its old format for downgrades', () => {
    legacy(linkedB, {
      remote: { '9': { base: 'main', prs: [5, 6] } },
    });
    legacy(linkedA, {
      remote: { '9': { base: 'main', prs: [5, 7] } },
    });
    withStore(linkedA, (store) => {
      store.state.remote['3'] = { base: 'main', prs: [1, 2] };
      store.save();
    });
    const state = legacyState(linkedA);
    expect(state.remote['3']).to.deep.equal({ base: 'main', prs: [1, 2] });
    // No alternatives or diagnostics: older gt compares these exactly.
    expect(Object.keys(state.remote['9']).sort()).to.deep.equal([
      'base',
      'prs',
    ]);
  });

  it('treats a malformed record as missing instead of failing every command', () => {
    withStore(linkedA, (store) => {
      store.state.remote['1'] = { base: 'main', prs: [1, 2] };
      store.state.remote['2'] = { base: 'main', prs: [3, 4] };
      store.save();
    });
    fs.writeFileSync(shared('remote', '1.json'), '{not json');
    fs.writeFileSync(shared('remote', '1.json.123.tmp'), '{partial');
    withStore(linkedB, (store) => {
      expect(store.state.remote['1']).to.equal(undefined);
      expect(store.state.remote['2'].prs).to.deep.equal([3, 4]);
      store.state.remote['1'] = { base: 'main', prs: [1, 2] };
      store.save();
    });
    expect(record(1).prs).to.deep.equal([1, 2]);
  });

  describe('migration from per-worktree records', () => {
    it('keeps a record where worktrees agree and adds records only one worktree has', () => {
      legacy(common, { remote: { '1': { base: 'main', prs: [1, 2] } } });
      legacy(linkedA, {
        remote: {
          '1': { base: 'main', prs: [1, 2] },
          '2': { base: 'main', prs: [3, 4] },
        },
      });
      // linkedB has no record at all (a new worktree): it adds nothing.
      withStore(linkedB, (store) => {
        expect(store.state.remote['1']).to.include({ base: 'main' });
        expect(store.state.remote['1'].alternatives).to.equal(undefined);
        expect(store.state.remote['2'].prs).to.deep.equal([3, 4]);
      });
      expect(fs.existsSync(shared('migrated'))).to.equal(true);
      expect(record(1).writtenBy).to.match(/^migration from /);
    });

    it('keeps every disagreeing record until GitHub shows which one is current', () => {
      legacy(linkedA, { remote: { '4': { base: 'main', prs: [1, 2, 3] } } });
      legacy(linkedB, { remote: { '4': { base: 'main', prs: [1, 2] } } });
      withStore(common, (store) => {
        const migrated = store.state.remote['4'];
        expect(recordMatches(migrated, 'main', [1, 2, 3])).to.equal(true);
        expect(recordMatches(migrated, 'main', [1, 2])).to.equal(true);
        expect(recordMatches(migrated, 'main', [2, 1])).to.equal(false);
        expect(recordMatches(migrated, 'other', [1, 2])).to.equal(false);
        // The next write records what gt observed and drops the others.
        store.state.remote['4'] = { base: 'main', prs: [1, 2, 3] };
        store.save();
      });
      expect(record(4).alternatives).to.equal(undefined);
      withStore(linkedB, (store) =>
        expect(recordMatches(store.state.remote['4'], 'main', [1, 2])).to.equal(
          false
        )
      );
    });

    it('runs once: later per-worktree writes by an older gt are not merged again', () => {
      legacy(linkedA, { remote: { '1': { base: 'main', prs: [1, 2] } } });
      withStore(linkedA, () => undefined);
      legacy(linkedB, { remote: { '8': { base: 'main', prs: [7, 8] } } });
      withStore(linkedB, (store) =>
        expect(store.state.remote['8']).to.equal(undefined)
      );
      expect(fs.readdirSync(shared('remote'))).to.deep.equal(['1.json']);
    });

    it('writes nothing when there is nothing to migrate', () => {
      withStore(linkedA, (store) => store.save());
      expect(fs.existsSync(shared('migrated'))).to.equal(false);
      expect(fs.existsSync(shared('remote'))).to.equal(false);
      withStore(linkedA, (store) => {
        store.state.remote['1'] = { base: 'main', prs: [1, 2] };
        store.save();
      });
      expect(fs.existsSync(shared('migrated'))).to.equal(true);
    });

    it('does not write from a lock-free snapshot, but still shows merged records', () => {
      legacy(linkedA, { remote: { '1': { base: 'main', prs: [1, 2] } } });
      const snapshot = StackStore.snapshot(linkedB, common);
      expect(snapshot.state.remote['1'].prs).to.deep.equal([1, 2]);
      expect(fs.existsSync(shared())).to.equal(false);
    });

    it('never clobbers a record another process wrote during migration', () => {
      legacy(linkedA, { remote: { '1': { base: 'main', prs: [1, 2] } } });
      fs.mkdirSync(shared('remote'), { recursive: true });
      fs.writeFileSync(
        shared('remote', '1.json'),
        JSON.stringify({ base: 'main', prs: [1, 2, 3] })
      );
      withStore(linkedB, (store) =>
        expect(store.state.remote['1'].prs).to.deep.equal([1, 2, 3])
      );
    });

    it('merges cleanup journals, keeping every survivor', () => {
      const merged = mergeLegacyStates([
        {
          pendingStackCleanups: {
            '3': { base: 'main', prs: [1, 2, 3], keep: [1] },
          },
        },
        {
          pendingStackCleanups: {
            '3': { base: 'main', prs: [1, 2, 3], keep: [1, 3] },
          },
        },
        {
          pendingStackCleanups: {
            '4': { base: 'main', prs: [4, 5, 6], keep: [4] },
          },
        },
        {
          pendingStackCleanups: {
            '4': { base: 'main', prs: [4, 5, 6], keep: [6] },
          },
        },
      ]);
      expect(merged.pendingStackCleanups?.['3'].keep).to.deep.equal([1, 3]);
      expect(merged.pendingStackCleanups?.['4'].keep).to.deep.equal([4, 6]);
    });
  });

  describe('cleanup claims', () => {
    it('lets only one process replay a stack cleanup, without waiting', () => {
      const a = new StackStore(linkedA, common);
      const b = new StackStore(linkedB, common);
      try {
        const release = a.claimStackCleanup(3);
        expect(release).to.be.a('function');
        expect(b.claimStackCleanup(3)).to.equal(undefined);
        // Other stacks are independent.
        const other = b.claimStackCleanup(4);
        expect(other).to.be.a('function');
        other?.();
        release?.();
        const next = b.claimStackCleanup(3);
        expect(next).to.be.a('function');
        next?.();
      } finally {
        a.close();
        b.close();
      }
    });

    it('releases claims when the store closes', () => {
      const a = new StackStore(linkedA, common);
      expect(a.claimStackCleanup(3)).to.be.a('function');
      a.close();
      withStore(linkedB, (store) =>
        expect(store.claimStackCleanup(3)).to.be.a('function')
      );
    });

    it('reads the journal on disk, not the snapshot loaded earlier', () => {
      const a = new StackStore(linkedA, common);
      try {
        withStore(linkedB, (store) => {
          store.state.pendingStackCleanups = {
            '3': { base: 'main', prs: [1, 2], keep: [1] },
          };
          store.save();
        });
        expect(a.state.pendingStackCleanups?.['3']).to.equal(undefined);
        expect(a.pendingCleanupOnDisk(3)?.keep).to.deep.equal([1]);
      } finally {
        a.close();
      }
    });
  });
});
