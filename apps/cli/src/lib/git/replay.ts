import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { runGitCommand } from './runner';
import { getGitTopLevel } from './git_dir';

/** Rewrite a branch onto a new base without checking it out.
 *
 * `git rebase --onto` must check out every branch it rewrites, which costs a
 * full working-tree switch per branch in a large repository. For the common
 * case (a linear branch, no conflicts, no signing, no rebase hooks) the same
 * commits can be produced with plumbing: the ORT merge machinery computes each
 * rebased tree, and `commit-tree` recreates the commit with its original
 * author and message. Anything outside that case, including every conflict,
 * is left to `git rebase` so behavior there is unchanged. Process count is
 * kept near a single rebase so small repositories do not pay for this either.
 */
export type ReplayResult = 'REBASE_DONE' | 'UNSUPPORTED' | 'CONFLICT';
/** Rebased commits, or why none were produced. CONFLICT means the same ORT
 * merge that git rebase would run reported conflicting changes. */
export type ReplayOutcome =
  | { tip: string; newTip: string; onto: string }
  | 'UNSUPPORTED'
  | 'CONFLICT';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_COMMITS = 1000;
let eligibleProcess: boolean | undefined;

/** Eligibility is evaluated once per process; tests change configuration in place. */
export function resetReplayEligibility(): void {
  eligibleProcess = undefined;
}

function git(args: string[], onError: 'throw' | 'ignore' = 'throw'): string {
  return runGitCommand({ args, onError, resource: 'replayBranch' });
}

function hooksDirectory(hooksPath: string | undefined): string {
  return hooksPath
    ? path.resolve(getGitTopLevel() || process.cwd(), hooksPath)
    : git(['rev-parse', '--git-path', 'hooks'], 'ignore');
}

function hookExists(directory: string, name: string): boolean {
  if (!directory) return true; // Unknown layout: let git rebase decide.
  try {
    fs.accessSync(path.join(directory, name), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Git and configuration whose rebase semantics the plumbing path reproduces.
 * Evaluated once per process: neither changes during one command.
 */
function eligible(): boolean {
  if (eligibleProcess !== undefined) return eligibleProcess;
  eligibleProcess = false;
  // merge-tree --write-tree arrived in Git 2.38 and --merge-base in 2.40.
  const match = /git version (\d+)\.(\d+)/.exec(git(['version'], 'ignore'));
  if (
    !match ||
    !(
      Number(match[1]) > 2 ||
      (Number(match[1]) === 2 && Number(match[2]) >= 40)
    )
  )
    return false;
  const settings = new Map<string, string>();
  for (const line of git(
    [
      'config',
      '--get-regexp',
      '^(commit\\.gpgsign|rebase\\.backend|rebase\\.updaterefs|rebase\\.rebasemerges|notes\\.rewriteref|core\\.hookspath)$',
    ],
    'ignore'
  ).split('\n')) {
    const separator = line.indexOf(' ');
    if (separator > 0)
      settings.set(
        line.slice(0, separator).toLowerCase(),
        line.slice(separator + 1)
      );
  }
  if (settings.get('commit.gpgsign')?.toLowerCase() === 'true') return false;
  if (settings.get('rebase.backend') === 'apply') return false;
  if (settings.get('rebase.updaterefs')?.toLowerCase() === 'true') return false;
  if (settings.has('rebase.rebasemerges') || settings.has('notes.rewriteref'))
    return false;
  const hooks = hooksDirectory(settings.get('core.hookspath'));
  if (hookExists(hooks, 'pre-rebase') || hookExists(hooks, 'post-rewrite'))
    return false;
  eligibleProcess = true;
  return true;
}

type CommitObject = {
  sha: string;
  tree: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  message: Buffer;
};

function parseCommit(sha: string, raw: Buffer): CommitObject | undefined {
  const separator = raw.indexOf('\n\n');
  if (separator < 0) return undefined;
  const headers = raw.subarray(0, separator).toString('utf8');
  if (headers.includes('\uFFFD')) return undefined; // Non-UTF-8 identity.
  let tree = '';
  const parents: string[] = [];
  let author: CommitObject['author'] | undefined;
  for (const line of headers.split('\n')) {
    if (line.startsWith(' ')) continue; // Continuation of a multi-line header.
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') {
      const match = /^(.*?) <([^>]*)> (\d+ [+-]\d{4})$/.exec(value);
      if (!match) return undefined;
      author = { name: match[1], email: match[2], date: match[3] };
    } else if (key === 'encoding') return undefined; // Re-encoding semantics.
  }
  if (!SHA.test(tree) || !author) return undefined;
  return { sha, tree, parents, author, message: raw.subarray(separator + 2) };
}

/** All commit objects in one cat-file process, in the requested order. */
function readCommits(shas: string[]): CommitObject[] | undefined {
  const result = spawnSync('git', ['cat-file', '--batch'], {
    // A string input with a buffer encoding is rejected; pass bytes.
    input: Buffer.from(shas.join('\n') + '\n'),
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  const commits: CommitObject[] = [];
  let offset = 0;
  for (const sha of shas) {
    const end = result.stdout.indexOf('\n', offset);
    if (end < 0) return undefined;
    const header = result.stdout
      .subarray(offset, end)
      .toString('utf8')
      .split(' ');
    if (header[0] !== sha || header[1] !== 'commit') return undefined;
    const size = Number(header[2]);
    const commit = parseCommit(
      sha,
      result.stdout.subarray(end + 1, end + 1 + size)
    );
    if (!commit) return undefined;
    commits.push(commit);
    offset = end + 1 + size + 1;
  }
  return commits;
}

function mergedTree(
  base: string,
  ours: string,
  theirs: string
): { tree: string } | 'CONFLICT' | 'UNSUPPORTED' {
  const result = spawnSync(
    'git',
    ['merge-tree', '--write-tree', '--merge-base', base, ours, theirs],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  if (result.error) throw result.error;
  const tree = result.stdout.split('\n')[0]?.trim() ?? '';
  // Exit 1 means conflicts: git rebase, which uses the same merge machinery,
  // would stop on this commit. Anything else is an unexpected failure that
  // falls back to git rebase.
  if (result.status === 1 && SHA.test(tree)) return 'CONFLICT';
  if (result.status !== 0 || !SHA.test(tree)) return 'UNSUPPORTED';
  return { tree };
}

function commitTree(args: {
  tree: string;
  parent: string;
  source: CommitObject;
  committerDateIsAuthorDate: boolean;
}): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: args.source.author.name,
    GIT_AUTHOR_EMAIL: args.source.author.email,
    GIT_AUTHOR_DATE: args.source.author.date,
    ...(args.committerDateIsAuthorDate
      ? { GIT_COMMITTER_DATE: args.source.author.date }
      : {}),
  };
  const result = spawnSync(
    'git',
    ['commit-tree', args.tree, '-p', args.parent, '-F', '-'],
    { input: args.source.message, env, encoding: 'utf8', windowsHide: true }
  );
  if (result.error) throw result.error;
  const sha = result.stdout.trim();
  if (result.status !== 0 || !SHA.test(sha))
    throw new Error(`git commit-tree failed: ${result.stderr}`);
  return sha;
}

type ReplayArgs = {
  onto: string;
  from: string;
  branchName: string;
  currentBranch: string | undefined;
  restackCommitterDateIsAuthorDate?: boolean;
};

export function replayBranch(args: ReplayArgs): ReplayResult {
  const replayed = replayCommits(args);
  if (typeof replayed === 'string') return replayed;
  const ref = `refs/heads/${args.branchName}`;
  // Same ref transitions as a completed rebase: the branch moves to its new
  // tip and ORIG_HEAD remembers the previous one. Compare-and-swap refuses to
  // overwrite a branch another process moved meanwhile.
  runGitCommand({
    args: [
      'update-ref',
      '-m',
      `rebase (finish): ${ref} onto ${replayed.onto}`,
      '--stdin',
    ],
    options: {
      input: `update ${ref} ${replayed.newTip} ${replayed.tip}\nupdate ORIG_HEAD ${replayed.tip}\n`,
    },
    onError: 'throw',
    resource: 'replayBranch',
  });
  return 'REBASE_DONE';
}

/** The rebased commits only: no ref changes. Callers that own a checkout in
 * another worktree move the branch there so its files follow. */
export function replayCommits(args: ReplayArgs): ReplayOutcome {
  if (args.currentBranch === args.branchName || !eligible())
    return 'UNSUPPORTED';
  const ref = `refs/heads/${args.branchName}`;
  const resolved = git(
    [
      'rev-parse',
      `${ref}^{commit}`,
      `${args.from}^{commit}`,
      `${args.onto}^{commit}`,
      `${args.onto}^{tree}`,
      `${args.from}^{tree}`,
    ],
    'ignore'
  ).split('\n');
  if (resolved.length !== 5 || !resolved.every((sha) => SHA.test(sha)))
    return 'UNSUPPORTED';
  const [tip, from, onto, ontoTree, fromTree] = resolved;
  const shas = git(
    [
      'rev-list',
      '--reverse',
      `--max-count=${MAX_COMMITS + 1}`,
      `${from}..${tip}`,
    ],
    'ignore'
  )
    .split('\n')
    .filter(Boolean);
  if (shas.length > MAX_COMMITS) return 'UNSUPPORTED';
  const commits = shas.length ? readCommits(shas) : [];
  if (!commits) return 'UNSUPPORTED';
  // git rebase replays from..tip; that range is only well defined here when it
  // is one linear chain starting at from (no merges to flatten, from an
  // ancestor). Every commit must have exactly the previous one as its parent.
  let expectedParent = from;
  for (const commit of commits) {
    if (commit.parents.length !== 1 || commit.parents[0] !== expectedParent)
      return 'UNSUPPORTED';
    expectedParent = commit.sha;
  }
  let parent = onto,
    parentTree = ontoTree,
    sourceParentTree = fromTree;
  for (const source of commits) {
    // Like git rebase, fast-forward over a commit already based on HEAD.
    // Recreating it would needlessly change its committer identity/date/SHA.
    // --committer-date-is-author-date implies --force-rebase, so that mode
    // must still recreate every retained commit, even when its parent matches.
    if (
      source.parents[0] === parent &&
      !args.restackCommitterDateIsAuthorDate
    ) {
      parent = source.sha;
      parentTree = sourceParentTree = source.tree;
      continue;
    }
    let tree: string;
    if (source.tree === sourceParentTree) {
      tree = parentTree; // Commits that started empty are kept, like rebase.
    } else {
      const merged = mergedTree(source.parents[0], parent, source.sha);
      if (typeof merged === 'string') return merged;
      sourceParentTree = source.tree;
      if (merged.tree === parentTree) continue; // Became empty: rebase drops it.
      tree = merged.tree;
    }
    sourceParentTree = source.tree;
    parent = commitTree({
      tree,
      parent,
      source,
      committerDateIsAuthorDate: !!args.restackCommitterDateIsAuthorDate,
    });
    parentTree = tree;
  }
  return { tip, newTip: parent, onto };
}
