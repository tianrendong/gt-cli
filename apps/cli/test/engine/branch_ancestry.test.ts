import { expect } from 'chai';
import { BasicScene } from '../lib/scenes/basic_scene';
import { configureTest } from '../lib/utils/configure_test';

// getAncestorBranchNames / getDescendantBranchNames replace one merge-base
// per branch pair with a single ref scan; they must agree with isDescendantOf.
const scene = new BasicScene();
describe(`(${scene}): batched branch ancestry`, function () {
  configureTest(this, scene);

  it('matches isDescendantOf for every pair of branches', () => {
    // main <- a <- b <- c, b2 at the same commit as b, side branch off a,
    // a tag that shadows a branch name, and a branch with disjoint history.
    scene.repo.createAndCheckoutBranch('a');
    scene.repo.createChangeAndCommit('a', 'a');
    scene.repo.createAndCheckoutBranch('b');
    scene.repo.createChangeAndCommit('b', 'b');
    scene.repo.runGitCommand(['branch', 'b2']);
    scene.repo.createAndCheckoutBranch('c');
    scene.repo.createChangeAndCommit('c', 'c');
    scene.repo.checkoutBranch('a');
    scene.repo.createAndCheckoutBranch('side');
    scene.repo.createChangeAndCommit('side', 'side');
    scene.repo.runGitCommand(['tag', 'b', 'main']);
    scene.repo.runGitCommand(['checkout', '--orphan', 'orphan']);
    scene.repo.createChangeAndCommit('orphan', 'orphan');
    scene.repo.checkoutBranch('main');

    const engine = scene.getContext().engine;
    const names = engine.allBranchNames;
    expect(names).to.include.members(['a', 'heads/b', 'b2', 'c', 'side']);

    for (const branch of names) {
      const ancestors = engine.getAncestorBranchNames(branch);
      const descendants = engine.getDescendantBranchNames(branch);
      for (const other of names) {
        expect(ancestors.has(other), `${other} ancestor of ${branch}`).to.eq(
          engine.isDescendantOf(branch, other)
        );
        expect(
          descendants.has(other),
          `${other} descendant of ${branch}`
        ).to.eq(engine.isDescendantOf(other, branch));
      }
    }

    expect([...engine.getAncestorBranchNames('c')].sort()).to.deep.eq([
      'a',
      'b2',
      'heads/b',
      'main',
    ]);
  });
});
