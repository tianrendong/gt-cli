#!/usr/bin/env node
/**
 * One-way migration: Graphite's SQLite metadata -> refs/branch-metadata/*.
 * Verified against Graphite 1.8.6. Requires a built gt-gh CLI; SQLite is bundled.
 *
 * Preserves parents, known published-tip leases, and best-effort PR associations.
 * Never contacts the network or modifies Graphite's own files. Stop Graphite
 * commands in every worktree before migrating; its SQLite store is independent.
 *
 * Usage: migrate-from-graphite.cjs [--repo <path>] [--dry-run] [--force]
 *        [--restore-missing-parents]
 * The restore option recreates only required missing ancestors at recorded
 * commits. It never guesses a new parent or rewrites an existing branch tip.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) =>
  args.indexOf(flag) < 0 ? undefined : args[args.indexOf(flag) + 1];
const cwd = path.resolve(value('--repo') || '.');
const dryRun = has('--dry-run');
const force = has('--force');
const restoreMissingParents = has('--restore-missing-parents');

const git = (argv, input) =>
  cp
    .execFileSync('git', argv, { cwd, input, encoding: 'utf8' })
    .replace(/\n$/, '');

function publishedTip(row) {
  if (row.last_submitted_version == null) return undefined;
  let version;
  try {
    version = JSON.parse(row.last_submitted_version);
  } catch {
    // An unknown format is not an unpublished branch. Fail before writing refs.
  }
  if (
    !version ||
    typeof version.headSha !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(version.headSha) ||
    (version.baseSha !== undefined &&
      (typeof version.baseSha !== 'string' ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(version.baseSha))) ||
    (version.baseName !== undefined && typeof version.baseName !== 'string') ||
    (version.versionNumber !== undefined &&
      (!Number.isSafeInteger(version.versionNumber) ||
        version.versionNumber < 0))
  ) {
    throw new Error(
      `Cannot migrate ${row.branch_name}: unrecognized last_submitted_version. Refusing to discard its published-tip lease. No metadata refs were changed.`
    );
  }
  return version.headSha;
}

function readPrInfo(gitDir) {
  // Best-effort associations; leases come from SQLite, not this optional cache.
  const prInfoByBranch = new Map();
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(gitDir, '.graphite_pr_info'), 'utf8')
    );
    for (const item of raw.prInfos || []) {
      const branch = item.headRefName || item.branchName || item.head;
      const number = item.prNumber ?? item.number;
      if (!branch || typeof number !== 'number') continue;
      const pr = { number };
      if (typeof item.url === 'string') pr.url = item.url;
      if (typeof item.title === 'string') pr.title = item.title;
      if (typeof item.body === 'string') pr.body = item.body;
      if (typeof item.baseRefName === 'string') pr.base = item.baseRefName;
      else if (typeof item.base === 'string') pr.base = item.base;
      if (typeof item.isDraft === 'boolean') pr.isDraft = item.isDraft;
      if (['OPEN', 'CLOSED', 'MERGED'].includes(item.state))
        pr.state = item.state;
      if (
        ['APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(
          item.reviewDecision
        )
      )
        pr.reviewDecision = item.reviewDecision;
      prInfoByBranch.set(branch, pr);
    }
  } catch {
    /* absent or unrecognized: parents and published-tip leases still migrate */
  }
  return prInfoByBranch;
}

function planMissingParents(
  rows,
  heads,
  existing,
  trunkNames,
  options = { git, force, restoreMissingParents }
) {
  const {
    git: runGit,
    force: replaceExisting,
    restoreMissingParents: restore,
  } = options;
  const byName = new Map(rows.map((row) => [row.branch_name, row]));
  const restored = new Map();
  const complete = new Set(trunkNames);
  const visiting = new Set();
  const blocked = new Map();
  const occupied = new Set(
    runGit(['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('branch refs/heads/'))
      .map((line) => line.slice('branch refs/heads/'.length))
  );
  function visit(branch) {
    if (complete.has(branch)) return;
    if (visiting.has(branch)) throw new Error(`Cycle in ancestry at ${branch}`);
    visiting.add(branch);
    try {
      const row = byName.get(branch);
      if (!heads.has(branch)) {
        if (!restore)
          throw new Error(
            `missing local parent ${branch}; preview --restore-missing-parents to recover its recorded commit`
          );
        try {
          runGit(['check-ref-format', `refs/heads/${branch}`]);
        } catch {
          throw new Error(
            `invalid recorded parent branch name ${JSON.stringify(branch)}`
          );
        }
        const sha = row?.branch_revision;
        if (
          typeof sha !== 'string' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)
        )
          throw new Error(
            `missing parent ${branch} has no valid recorded branch revision`
          );
        if (occupied.has(branch))
          throw new Error(
            `missing parent ${branch} is checked out in another worktree`
          );
        try {
          runGit(['cat-file', '-e', `${sha}^{commit}`]);
        } catch {
          throw new Error(
            `recorded commit for missing parent ${branch} is unavailable; fetch it before migrating`
          );
        }
        restored.set(branch, sha);
      }
      // Existing gt-gh metadata is authoritative unless --force was requested.
      const parent =
        existing.has(branch) && !replaceExisting
          ? JSON.parse(
              runGit(['cat-file', '-p', `refs/branch-metadata/${branch}`])
            ).parentBranchName
          : row?.parent_branch_name;
      // Native untrack can leave children pointing at a surviving untracked
      // branch. Preserve that boundary; do not infer tracking or reparenting.
      // A missing head still requires complete recorded ancestry for recovery.
      if (parent) visit(parent);
      else if (!heads.has(branch))
        throw new Error(`untracked ancestor ${branch} has no recorded parent`);
      complete.add(branch);
    } finally {
      visiting.delete(branch);
    }
  }
  for (const row of rows) {
    if (
      !heads.has(row.branch_name) ||
      !row.parent_branch_name ||
      trunkNames.has(row.branch_name) ||
      (existing.has(row.branch_name) && !replaceExisting)
    )
      continue;
    try {
      visit(row.branch_name);
    } catch (error) {
      blocked.set(row.branch_name, error.message);
    }
  }
  if (blocked.size) {
    for (const [branch, reason] of blocked)
      console.error(`blocked ${branch}: ${reason}`);
    throw new Error(
      'Incomplete ancestry. No refs were changed. Resolve the listed parents, or preview --restore-missing-parents; no reparenting is inferred.'
    );
  }
  return restored;
}

async function main() {
  const gitDir = path.resolve(cwd, git(['rev-parse', '--git-common-dir']));
  const worktreeDir = git(['rev-parse', '--absolute-git-dir']);
  const db = path.join(gitDir, '.graphite_metadata.db');
  if (!fs.existsSync(db)) {
    throw new Error(`No Graphite database at ${db}. Nothing to migrate.`);
  }
  const storeModule = [
    '../dist/src/lib/github/stack_file.js', // source checkout
    '../src/lib/github/stack_file.js', // packaged dist/scripts
  ]
    .map((relative) => path.resolve(__dirname, relative))
    .find((file) => fs.existsSync(file));
  if (!storeModule) {
    throw new Error('Build gt-gh first with npm run build before migrating.');
  }
  const { StackStore } = require(storeModule);
  if (typeof StackStore.open !== 'function') {
    throw new Error('Rebuild gt-gh with npm run build before migrating.');
  }
  // Use the same common-repo/worktree locks as CLI commands. No mirror is saved.
  const store = await StackStore.open(worktreeDir, gitDir);
  try {
    const { sqlite } = require(path.resolve(
      path.dirname(storeModule),
      '../switch/sqlite.js'
    ));
    const rows = JSON.parse(
      sqlite(db, 'select * from branch_metadata') || '[]'
    );
    const prInfoByBranch = readPrInfo(gitDir);
    const headRevisions = new Map(
      git([
        'for-each-ref',
        '--format=%(refname:lstrip=2) %(objectname)',
        'refs/heads/',
      ])
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' '))
    );
    const heads = new Set(headRevisions.keys());
    const existing = new Map(
      git([
        'for-each-ref',
        '--format=%(refname:lstrip=2) %(objectname)',
        'refs/branch-metadata/',
      ])
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' '))
    );

    const configPath = path.join(gitDir, '.graphite_repo_config');
    const config = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
      : {};
    const trunkNames = new Set(
      [
        config.trunk,
        ...(config.additionalTrunks || []),
        ...rows
          .filter((row) => row.validation_result === 'TRUNK')
          .map((row) => row.branch_name),
      ].filter((name) => typeof name === 'string' && heads.has(name))
    );
    const restored = planMissingParents(rows, heads, existing, trunkNames);
    for (const branch of restored.keys()) heads.add(branch);
    const plan = [];
    const skipped = [];
    for (const row of rows) {
      const branch = row.branch_name;
      if (row.validation_result === 'TRUNK' || !row.parent_branch_name)
        continue;
      if (!heads.has(branch)) {
        skipped.push(`${branch}: branch no longer exists`);
        continue;
      }
      if (!heads.has(row.parent_branch_name)) {
        skipped.push(`${branch}: parent ${row.parent_branch_name} missing`);
        continue;
      }
      if (existing.has(branch) && !force) {
        skipped.push(`${branch}: gt metadata already present (use --force)`);
        continue;
      }
      const remoteRevision = publishedTip(row);
      const prInfo = {
        ...prInfoByBranch.get(branch),
        ...(remoteRevision ? { remoteRevision } : {}),
      };
      plan.push({
        branch,
        meta: {
          parentBranchName: row.parent_branch_name,
          ...(row.parent_branch_revision
            ? { parentBranchRevision: row.parent_branch_revision }
            : {}),
          ...(Object.keys(prInfo).length ? { prInfo } : {}),
          ...(row.last_submitted_version
            ? { lastSubmittedVersion: JSON.parse(row.last_submitted_version) }
            : {}),
        },
      });
    }

    if (!dryRun && plan.length) {
      // Validate every row before writing. Commit all metadata refs atomically,
      // with expected old OIDs so a non-cooperating writer cannot be overwritten.
      const updates = plan.map(({ branch, meta }) => {
        const sha = git(
          ['hash-object', '-w', '--stdin'],
          JSON.stringify(meta, null, 2)
        );
        const ref = `refs/branch-metadata/${branch}`;
        return existing.has(branch)
          ? `update ${ref} ${sha} ${existing.get(branch)}`
          : `create ${ref} ${sha}`;
      });
      git(
        ['update-ref', '--stdin'],
        [
          'start',
          ...[...headRevisions].map(
            ([branch, sha]) => `verify refs/heads/${branch} ${sha}`
          ),
          ...[...restored].map(
            ([branch, sha]) => `create refs/heads/${branch} ${sha}`
          ),
          ...updates,
          'prepare',
          'commit',
          '',
        ].join('\n')
      );
    }
    for (const [branch, sha] of restored)
      console.log(
        `${
          dryRun ? 'would restore' : 'restored'
        } missing parent ${branch} at ${sha}`
      );
    for (const { branch, meta } of plan) {
      console.log(
        `${dryRun ? 'would migrate' : 'migrated'} ${branch} <- ${
          meta.parentBranchName
        }${meta.prInfo?.number ? ` (PR #${meta.prInfo.number})` : ''}`
      );
    }
    for (const line of skipped) console.log(`skipped ${line}`);
    console.log(
      `${dryRun ? 'Would migrate' : 'Migrated'} ${
        plan.length
      } branch(es); skipped ${skipped.length}.`
    );
    console.log(
      `${dryRun ? 'Would preserve' : 'Preserved'} ${
        plan.filter(({ meta }) => meta.prInfo?.remoteRevision).length
      } published-tip lease(s).`
    );
    console.log(
      'Graphite files were not modified. Verify with: gt log --stack (stale parent revisions self-heal on first parse).'
    );
  } finally {
    store.close();
  }
}

module.exports = { publishedTip, readPrInfo, planMissingParents };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
