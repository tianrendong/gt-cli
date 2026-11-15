import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { inferPRBody } from '../../src/actions/submit/pr_body';
import { getPRTitle } from '../../src/actions/submit/pr_title';
import {
  hasPrBodyTree,
  removePrBodyTrees,
  updatePrBodyFooter,
} from '../../src/actions/submit/submit_action';
import {
  footerFooter,
  footerTitle,
} from '../../src/actions/create_pr_body_footer';
import { validateNoEmptyBranches } from '../../src/actions/submit/validate_branches';
import { BasicScene } from '../lib/scenes/basic_scene';
import { configureTest } from '../lib/utils/configure_test';

use(chaiAsPromised);

for (const scene of [new BasicScene()]) {
  describe(`(${scene}): correctly infers submit info from commits`, function () {
    configureTest(this, scene);

    it('can infer title/body from single commit', async () => {
      const title = 'Test Title';
      const body = ['Test body line 1.', 'Test body line 2.'].join('\n');
      const message = `${title}\n\n${body}`;

      scene.repo.createChange('a');
      scene.repo.runCliCommand([`branch`, `create`, `a`, `-m`, message]);

      expect(
        await getPRTitle(
          { branchName: 'a', editPRFieldsInline: false },
          scene.getContext()
        )
      ).to.equals(title);
      expect(
        inferPRBody(
          { branchName: 'a', template: 'template' },
          scene.getContext()
        ).inferredBody
      ).to.equals(`template`);

      scene
        .getContext()
        .userConfig.update((data) => (data.submitIncludeCommitMessages = true));

      expect(
        await getPRTitle(
          { branchName: 'a', editPRFieldsInline: false },
          scene.getContext()
        )
      ).to.equals(title);
      expect(
        inferPRBody(
          { branchName: 'a', template: 'template' },
          scene.getContext()
        ).inferredBody
      ).to.equals(`${body}\n\ntemplate`);
    });

    it('can infer just title with no body', async () => {
      const title = 'Test Title';
      const commitMessage = title;

      scene.repo.createChange('a');
      scene.repo.runCliCommand([`branch`, `create`, `a`, `-m`, commitMessage]);

      expect(
        await getPRTitle(
          { branchName: 'a', editPRFieldsInline: false },
          scene.getContext()
        )
      ).to.equals(title);
      expect(
        inferPRBody(
          { branchName: 'a', template: 'template' },
          scene.getContext()
        ).inferredBody
      ).to.equal('template');
    });

    it('can infer title/body from multiple commits', async () => {
      const title = 'Test Title';
      const secondSubj = 'Second commit subject';

      scene.repo.createChange('a');
      scene.repo.runCliCommand([`branch`, `create`, `a`, `-m`, title]);
      scene.repo.createChangeAndCommit(secondSubj);

      expect(
        await getPRTitle(
          { branchName: 'a', editPRFieldsInline: false },
          scene.getContext()
        )
      ).to.equals(title);
      expect(
        inferPRBody({ branchName: 'a' }, scene.getContext()).inferredBody
      ).to.equal(``);

      scene
        .getContext()
        .userConfig.update((data) => (data.submitIncludeCommitMessages = true));

      expect(
        await getPRTitle(
          { branchName: 'a', editPRFieldsInline: false },
          scene.getContext()
        )
      ).to.equals(title);
      expect(
        inferPRBody({ branchName: 'a' }, scene.getContext()).inferredBody
      ).to.equal(`${title}\n\n${secondSubj}`);
    });

    it('aborts if the branch is empty', async () => {
      scene.repo.runCliCommand([`branch`, `create`, `a`, `-m`, `a`]);
      await expect(validateNoEmptyBranches(['a'], scene.getContext())).to.be
        .rejected;
    });

    it('does not abort if the branch is not empty', async () => {
      scene.repo.createChange('a');
      scene.repo.runCliCommand([`branch`, `create`, `a`, `-m`, `a`]);
      await expect(validateNoEmptyBranches(['a'], scene.getContext())).to.be
        .fulfilled;
    });
  });
}

describe('updatePrBodyFooter', () => {
  const tree = (n: number) =>
    `${footerTitle}* **PR #${n}** 👈\n${footerFooter}`;
  const newFooter = tree(83);
  const text = `Fix issue where dependency tree prints multiple times

**Test Plan:**

![CleanShot](https://example.com/shot.png)`;

  it('uses the footer alone for a missing or empty body', () => {
    expect(updatePrBodyFooter(undefined, newFooter)).to.equal(newFooter);
    expect(updatePrBodyFooter('', newFooter)).to.equal(newFooter);
  });

  it('appends the footer when there is no tree', () => {
    expect(updatePrBodyFooter(text, newFooter)).to.equal(text + newFooter);
    expect(updatePrBodyFooter(`${text}\n\n`, newFooter)).to.equal(
      text + newFooter
    );
  });

  it('is a no-op when the body already ends with the same tree', () => {
    const body = text + newFooter;
    expect(updatePrBodyFooter(body, newFooter)).to.equal(body);
  });

  for (const [name, suffix] of [
    ['nothing', ''],
    ['a newline', '\n'],
    ['CRLF', '\r\n'],
    ['several newlines', '\n\n\n'],
  ]) {
    it(`replaces a tree followed by ${name} instead of adding another`, () => {
      expect(updatePrBodyFooter(text + tree(1) + suffix, newFooter)).to.equal(
        text + newFooter
      );
    });
  }

  it('repairs a body that already has two trees', () => {
    const body = `${text}${tree(1)}\n${tree(2)}\n`;
    expect(updatePrBodyFooter(body, newFooter)).to.equal(text + newFooter);
  });

  it('keeps text written after a tree and moves the tree to the end', () => {
    const body = `${text}${tree(1)}\n\nAdded later.\n`;
    expect(updatePrBodyFooter(body, newFooter)).to.equal(
      `${text}\n\nAdded later.${newFooter}`
    );
  });

  it('replaces a body that consists only of a tree', () => {
    expect(updatePrBodyFooter(tree(1), newFooter)).to.equal(newFooter);
    expect(updatePrBodyFooter(tree(1) + '\n', newFooter)).to.equal(newFooter);
  });

  it('does not let a stray heading swallow the text before a later tree', () => {
    const body = `#### PR Dependency Tree\n\nmy notes${tree(1)}`;
    expect(updatePrBodyFooter(body, newFooter)).to.equal(
      `#### PR Dependency Tree\n\nmy notes${newFooter}`
    );
  });

  it('is stable: updating twice equals updating once', () => {
    const once = updatePrBodyFooter(`${text}${tree(1)}\r\n`, newFooter);
    expect(updatePrBodyFooter(once, newFooter)).to.equal(once);
  });
});

describe('removePrBodyTrees', () => {
  const tree = `${footerTitle}* **PR #1** 👈\n${footerFooter}`;
  it('removes every tree and leaves other text alone', () => {
    expect(hasPrBodyTree('plain body')).to.equal(false);
    expect(hasPrBodyTree(`body${tree}`)).to.equal(true);
    expect(removePrBodyTrees(`body${tree}\n${tree}\n`)).to.equal('body');
    expect(removePrBodyTrees(`${tree}\n`)).to.equal('');
  });
});
