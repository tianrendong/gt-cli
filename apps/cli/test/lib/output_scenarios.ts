import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stopIsolatedNativeHelpers } from '../../src/lib/switch/native';

export type OutputCase = {
  id: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
};

/** Identical local-only scenarios for native gt and our CLI. Never use a real
 * repository, user config, credentials, remote, editor, or interactive prompt.
 * Preserve ANSI, whitespace, streams, exit codes, and deterministic commit IDs.
 */
export function runOutputScenarios(opts: {
  cli: string[];
  native?: boolean;
  onCase?: (result: OutputCase) => void;
}): OutputCase[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-switch-test-output-'));
  const home = path.join(root, 'home');
  let repo = path.join(root, 'repo');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    GH_CONFIG_DIR: path.join(home, '.config/gh'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
    GIT_EDITOR: 'true',
    GT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GT_PAGER: '',
    GRAPHITE_USER_CONFIG_PATH: path.join(home, 'user.json'),
    GRAPHITE_DISABLE_TELEMETRY: '1',
    GRAPHITE_DISABLE_UPGRADE_PROMPT: '1',
    GRAPHITE_DISABLE_SURVEY: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
    TZ: 'UTC',
    LC_ALL: 'C',
  };
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(home, '.config/graphite'), { recursive: true });
  fs.mkdirSync(path.join(home, '.local/share/graphite'), { recursive: true });
  fs.writeFileSync(env.GRAPHITE_USER_CONFIG_PATH!, '{"tips":false}');
  fs.writeFileSync(
    path.join(home, '.config/graphite/user_config'),
    '{"updateAutomatically":false,"tips":false}'
  );
  // Native has separate onboarding and new-feature tip switches. Turn both
  // off rather than stripping potentially important stderr from comparisons.
  fs.writeFileSync(
    path.join(home, '.local/share/graphite/nuxes'),
    JSON.stringify({
      nuxes: {
        'modify.into': {
          showCount: 3,
          dismissed: true,
          lastShown: '2024-01-01T00:00:00Z',
        },
      },
      settings: { newUserTipsEnabled: false, newFeatureTipsEnabled: false },
    })
  );

  const results: OutputCase[] = [];
  const execute = (cli: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(cli[0], cli.slice(1), {
      cwd: repo,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.signal, null, `${cli.join(' ')} was killed`);
    return result;
  };
  const git = (...args: string[]): string => {
    const result = execute(['git', ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const normalize = (text: string): string =>
    text
      .split(fs.realpathSync(root))
      .join('<ROOT>')
      .split(root)
      .join('<ROOT>')
      .replace(
        /\d+ (?:second|minute|hour|day|week|month|year)s?(?:, \d+ (?:second|minute|hour|day|week|month|year)s?)? ago\b/g,
        '<relative date>'
      );
  const run = (
    id: string,
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      gitPassthrough?: boolean;
      // Paging is an interactive feature; prompts still cannot run without a
      // terminal, so only use this for commands that never prompt.
      interactive?: boolean;
    } = {}
  ) => {
    const result = execute(
      [
        ...opts.cli,
        ...args,
        ...(options.gitPassthrough
          ? []
          : [options.interactive ? '--interactive' : '--no-interactive']),
      ],
      options.env
    );
    const output = {
      id,
      args,
      status: result.status,
      stdout: normalize(result.stdout),
      stderr: normalize(result.stderr),
    };
    results.push(output);
    opts.onCase?.(output);
  };
  const change = (name: string, contents: string) => {
    fs.writeFileSync(path.join(repo, name), contents + '\n');
    git('add', '--', name);
  };
  const hook = (contents: string) => {
    fs.writeFileSync(path.join(repo, '.git/hooks/pre-commit'), contents, {
      mode: 0o755,
    });
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Tester');
    git('config', 'user.email', 'tester@example.com');
    git('config', 'commit.gpgSign', 'false');
    for (const n of [0, 1]) {
      change('base.txt', String(n));
      git('commit', '-qm', `Base ${n}`);
    }
    run('init', ['init', '--trunk', 'main']);
    run('trunk.info', ['info']);
    run('trunk.restack', ['restack']);
    run('trunk.children', ['children']);
    run('trunk.parent', ['parent']);
    run('trunk.down', ['down']);
    run('passthrough.status', ['status', '--short'], { gitPassthrough: true });
    for (const name of ['one', 'two']) {
      change(name + '.txt', name);
      run(`create.${name}`, ['create', name, '-m', `${name} commit`]);
    }
    for (const [id, args] of [
      ['log', ['log']],
      ['ls', ['ls']],
      ['ll', ['ll']],
      ['info', ['info']],
      ['parent', ['parent']],
    ] as const) {
      run(id, [...args]);
      run(`${id}.plain`, [...args], { env: { FORCE_COLOR: '0' } });
      run(`${id}.auto`, [...args], { env: { FORCE_COLOR: undefined } });
      run(`${id}.no-color`, [...args], {
        env: { FORCE_COLOR: undefined, NO_COLOR: '1' },
      });
      run(`${id}.quiet`, [...args, '--quiet']);
    }
    run('log.reverse', ['log', '--reverse']);
    run('ls.reverse', ['ls', '--reverse']);
    run('log.stack', ['log', '--stack']);
    run('log.steps', ['log', '--steps', '1']);
    run('info.parent', ['info', 'one']);
    run('info.patch', ['info', '--patch']);
    run('info.diff', ['info', '--diff']);
    run('info.stat', ['info', '--stat']);
    run('info.stat.patch', ['info', '--stat', '--patch']);
    run('info.stat.diff', ['info', '--stat', '--diff']);
    run('children.leaf', ['children']);
    const pager = { GT_PAGER: 'echo PAGER_USED; cat' };
    run('pager.pipe', ['ls'], { env: pager });
    run('pager.interactive', ['ls'], { env: pager, interactive: true });
    run('pager.interactive.log', ['log'], { env: pager, interactive: true });
    run('pager.interactive.info', ['info'], { env: pager, interactive: true });
    run('pager.interactive.quiet', ['ls', '--quiet'], {
      env: pager,
      interactive: true,
    });
    run('pager.interactive.failure', ['ls'], {
      env: { GT_PAGER: 'exit 3' },
      interactive: true,
    });
    change('two.txt', 'two modified');
    run('modify', ['modify', '--no-edit']);
    change('two.txt', 'two modified quietly');
    run('modify.quiet', ['modify', '--no-edit', '--quiet']);
    run('down', ['down']);
    run('down.trunk', ['down']);
    run('up', ['up']);
    run('top', ['top']);
    run('top.noop', ['top']);
    run('up.noop', ['up']);
    run('bottom', ['bottom']);
    run('bottom.noop', ['bottom']);
    run('checkout.noop', ['checkout', 'one']);
    run('checkout.trunk', ['checkout', 'main']);
    run('create.empty', ['create', 'empty', '-m', 'Empty']);
    run('empty.log', ['log']);
    run('empty.ls', ['ls']);
    run('empty.info', ['info']);
    run('delete.empty', ['delete', 'empty', '--force']);
    change('quiet.txt', 'quiet');
    run('create.quiet', ['create', 'quiet', '-m', 'Quiet', '--quiet']);
    run('delete.quiet', ['delete', 'quiet', '--force', '--quiet']);
    run('freeze', ['freeze', 'two']);
    run('freeze.noop', ['freeze', 'two']);
    run('frozen.log', ['log']);
    run('frozen.ls', ['ls']);
    run('frozen.info', ['info', 'two']);
    run('checkout.frozen', ['checkout', 'two']);
    run('frozen.restack', ['restack']);
    run('frozen.restack.quiet', ['restack', '--quiet']);
    run('unfreeze', ['unfreeze', 'one']);
    run('unfreeze.noop', ['unfreeze', 'one']);
    run('checkout.trunk.again', ['checkout', 'main']);
    for (const name of ['zeta', 'alpha']) {
      change(name + '.txt', name);
      run(`create.${name}`, ['create', name, '-m', `${name} commit`]);
      run(`checkout.after-${name}`, ['checkout', 'main']);
    }
    run('siblings.log', ['log']);
    run('siblings.ls', ['ls']);
    run('siblings.reverse', ['log', '--reverse']);
    run('siblings.children', ['children']);
    run('siblings.up', ['up']);
    run('untrack', ['untrack', 'alpha']);
    run('log.untracked', ['log', '--show-untracked']);
    run('checkout.untracked', ['checkout', 'alpha']);
    run('parent.untracked', ['parent']);
    run('track', ['track', 'alpha', '--parent', 'main']);
    run('track.again', ['track', 'alpha', '--parent', 'main']);
    run('rename', ['rename', 'beta']);
    run('checkout.before-advance', ['checkout', 'main']);
    change('base.txt', 'updated base');
    git('commit', '-qm', 'Updated base');
    run('freeze.stale', ['freeze', 'zeta']);
    run('stale.log', ['log']);
    run('stale.ls', ['ls']);
    run('checkout.stale-ancestor', ['checkout', 'two']);
    run('checkout.stale', ['checkout', 'beta']);
    run('restack', ['restack']);
    run('restack.noop', ['restack']);
    run('checkout.before-hook', ['checkout', 'main']);
    hook('#!/bin/sh\nprintf "hook stdout\\n"\nprintf "hook stderr\\n" >&2\n');
    change('hook.txt', 'hook');
    run('create.hook', ['create', 'hook', '-m', 'Hook']);
    change('hook.txt', 'hook modified');
    run('modify.hook.quiet', ['modify', '--no-edit', '--quiet']);
    hook(
      '#!/bin/sh\nprintf "failure stdout\\n"\nprintf "failure stderr\\n" >&2\nexit 1\n'
    );
    change('hook.txt', 'hook failure');
    run('modify.hook.failure', ['modify', '--no-edit']);
    run('error.missing', ['checkout', 'missing']);
    run('error.missing.quiet', ['checkout', 'missing', '--quiet']);
    run('error.missing.plain', ['checkout', 'missing'], {
      env: { FORCE_COLOR: '0' },
    });

    // Seed both legacy native metadata and our metadata refs with identical
    // cached PRs. These are display tests, not calls to GitHub or Graphite.
    repo = path.join(root, 'prs');
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Tester');
    git('config', 'user.email', 'tester@example.com');
    for (const n of [0, 1]) {
      change('base.txt', String(n));
      git('commit', '-qm', `Base ${n}`);
    }
    const main = git('rev-parse', 'main');
    const prs: Record<string, unknown>[] = [];
    const states = [
      ['approved', 'OPEN', false, 'APPROVED'],
      ['closed', 'CLOSED', false, undefined],
      ['draft', 'OPEN', true, 'REVIEW_REQUIRED'],
      ['merged', 'MERGED', false, undefined],
      ['open', 'OPEN', false, undefined],
      ['requested', 'OPEN', false, 'CHANGES_REQUESTED'],
      ['required', 'OPEN', false, 'REVIEW_REQUIRED'],
      ['no-pr', 'OPEN', false, undefined],
    ] as const;
    for (const [
      i,
      [branch, state, isDraft, reviewDecision],
    ] of states.entries()) {
      git('checkout', '-b', branch, 'main');
      change(branch + '.txt', branch);
      git('commit', '-qm', `${branch} commit`);
      const head = git('rev-parse', 'HEAD');
      const info = {
        id: `PR_${101 + i}`,
        number: 101 + i,
        url: `https://github.com/test/repo/pull/${101 + i}`,
        title: `${branch} title`,
        body: 'PR body\n\nDetails.',
        state,
        isDraft,
        reviewDecision,
        base: 'main',
        remoteRevision: head,
      };
      if (branch !== 'no-pr')
        prs.push({
          ...info,
          prNumber: info.number,
          headRefName: branch,
          baseRefName: 'main',
          isCrossRepository: false,
          authorGithubHandle: 'test',
          isBaseRefGraphiteBase: false,
          versions: [],
          cliTrunk: 'main',
        });
      const metadata = path.join(root, 'metadata.json');
      fs.writeFileSync(
        metadata,
        JSON.stringify({
          parentBranchName: 'main',
          parentBranchRevision: main,
          lastSubmittedVersion: {
            headSha: head,
            baseSha: main,
            baseName: 'main',
            versionNumber: 1,
          },
          ...(branch === 'no-pr' ? {} : { prInfo: info }),
        })
      );
      git(
        'update-ref',
        `refs/branch-metadata/${branch}`,
        git('hash-object', '-w', metadata)
      );
    }
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_repo_config'),
      JSON.stringify({
        trunk: 'main',
        trunks: [{ name: 'main' }],
        owner: 'test',
        name: 'repo',
        host: 'github.com',
        lastFetchedPRInfoMs: 9999999999999,
        lastFetchedFeatureFlagsInMs: 9999999999999,
      })
    );
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_pr_info'),
      JSON.stringify({
        prInfos: prs,
        mergeabilityStatuses: [],
      })
    );
    run('pr.log', ['log']);
    run('pr.log.plain', ['log'], { env: { FORCE_COLOR: '0' } });
    run('pr.ls', ['ls']);
    run('pr.info.body', ['info', 'approved', '--body']);
    run('pr.info.closed', ['info', 'closed']);
    run('pr.info.no-pr', ['info', 'no-pr']);
    for (const branch of ['approved', 'open', 'draft', 'closed', 'merged']) {
      run(`pr.checkout.${branch}`, ['checkout', branch]);
    }
    run('pr.unlink.open', ['unlink', 'open']);
    run('pr.unlink.again', ['unlink', 'open']);
    run('pr.freeze.merged', ['freeze', 'merged']);
    run('pr.info.merged-frozen', ['info', 'merged']);
    run('pr.ls.merged-frozen', ['ls']);
    git('checkout', 'approved');
    change('approved.txt', 'unsubmitted change');
    git('commit', '-qm', 'Unsubmitted');
    git('checkout', 'merged');
    run('pr.checkout.unsubmitted', ['checkout', 'approved']);
    git('checkout', 'merged');
    git('worktree', 'add', path.join(root, 'linked'), 'approved');
    run('worktree.log', ['log']);
    run('worktree.ls', ['ls']);
    run('worktree.info', ['info', 'approved']);
    run('worktree.freeze', ['freeze', 'approved']);
    run('worktree.frozen.log', ['log']);
    run('worktree.frozen.ls', ['ls']);
    repo = path.join(root, 'linked');
    run('worktree.linked.log', ['log']);
    run('worktree.linked.ls', ['ls']);

    // Stack surgery and conflict handling, entirely local.
    repo = path.join(root, 'flows');
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Tester');
    git('config', 'user.email', 'tester@example.com');
    change('shared.txt', 'base');
    git('commit', '-qm', 'Base');
    run('flow.init', ['init', '--trunk', 'main']);
    run('flow.trunk', ['trunk']);
    run('flow.trunk.all', ['trunk', '--all']);
    run('flow.continue.idle', ['continue']);
    run('flow.abort.idle', ['abort', '--force']);
    for (const name of ['a', 'b', 'c']) {
      change(name + '.txt', name);
      run(`flow.create.${name}`, ['create', name, '-m', `${name} commit`]);
    }
    change('c-extra.txt', 'extra');
    git('commit', '-qm', 'Second c commit');
    run('flow.squash', ['squash', '--no-edit']);
    run('flow.squash.single', ['squash', '--no-edit']);
    run('flow.absorb.nothing', ['absorb', '--force']);
    change('b.txt', 'b absorbed');
    run('flow.absorb.dry-run', ['absorb', '--dry-run']);
    run('flow.absorb', ['absorb', '--force']);
    run('flow.log.after-absorb', ['log']);
    // Multiple hunks per file, several owning commits, and hunks that cannot
    // be absorbed at all (trunk-owned, new file, binary).
    change(
      'wide.txt',
      ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'].join('\n')
    );
    run('flow.create.wide', ['create', 'wide', '-m', 'wide commit']);
    change(
      'wide.txt',
      ['w1 edited', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8 edited'].join('\n')
    );
    change('shared.txt', 'trunk owned edit');
    change('created.txt', 'brand new');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    git('add', '--', 'blob.bin');
    run('flow.absorb.mixed.dry-run', ['absorb', '--dry-run']);
    run('flow.absorb.mixed', ['absorb', '--force']);
    run('flow.absorb.mixed.log', ['log']);
    run('flow.absorb.leftover', ['absorb', '--force']);
    // Leave a clean tree: gt refuses stack surgery with uncommitted changes.
    git('reset', '--hard', '-q');
    git('clean', '-qfd');
    run('flow.checkout.after-absorb', ['checkout', 'c']);
    run('flow.move', ['move', '--onto', 'a', '--source', 'c']);
    run('flow.move.only', ['move', '--onto', 'main', '--only']);
    run('flow.log.after-move', ['log']);
    run('flow.fold.keep', ['fold', '--keep']);
    run('flow.fold', ['fold']);
    run('flow.log.after-fold', ['log']);
    run('flow.unlink', ['unlink']);
    run('flow.pop', ['pop']);
    run('flow.log.after-pop', ['log']);
    run('flow.undo', ['undo', '--force']);

    // Restack conflicts: halt, inspect, abort, then resolve and continue.
    repo = path.join(root, 'conflicts');
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Tester');
    git('config', 'user.email', 'tester@example.com');
    change('shared.txt', 'base');
    git('commit', '-qm', 'Base');
    run('conflict.init', ['init', '--trunk', 'main']);
    change('shared.txt', 'branch version');
    run('conflict.create', ['create', 'conflicting', '-m', 'Conflicting']);
    run('flow.checkout.trunk', ['checkout', 'main']);
    change('shared.txt', 'upstream');
    git('commit', '-qm', 'Upstream change');
    run('flow.restack.conflict', ['restack']);
    run('flow.conflict.log', ['log']);
    run('flow.conflict.ls', ['ls']);
    run('flow.conflict.status', ['status', '--short'], {
      gitPassthrough: true,
    });
    run('flow.continue.unresolved', ['continue']);
    run('flow.abort', ['abort', '--force']);
    run('flow.log.after-abort', ['log']);
    run('flow.restack.conflict.again', ['restack']);
    change('shared.txt', 'resolved');
    run('flow.continue', ['continue']);
    run('flow.log.after-continue', ['log']);
    run('flow.abort.after-continue', ['abort', '--force']);

    // Errors and refusals, including operations on trunk.
    run('error.create.nothing-staged', ['create', 'nothing', '-m', 'Nothing']);
    run('error.info.missing', ['info', 'missing']);
    run('flow.checkout.trunk.again', ['checkout', 'main']);
    run('error.delete.trunk', ['delete', 'main', '--force']);
    run('error.untrack.trunk', ['untrack', 'main', '--force']);
    run('error.rename.trunk', ['rename', 'renamed']);
    run('error.squash.trunk', ['squash', '--no-edit']);
    run('error.fold.trunk', ['fold']);
    run('error.pop.trunk', ['pop']);
    run('error.move.trunk', ['move', '--onto', 'conflicting']);
    run('error.absorb.trunk', ['absorb', '--force']);
    run('error.unlink.trunk', ['unlink']);
    return results;
  } finally {
    if (opts.native) stopIsolatedNativeHelpers(root, opts.cli[0]);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
