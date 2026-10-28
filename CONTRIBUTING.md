# Contributing

Open-source repository and npm package. Include context and test results with your PR.

## Build

Use Node **22.16+ within 22.x**. From the repository root:

```sh
nvm install 22
nvm use
corepack enable
corepack yarn install --immutable
corepack yarn build
```

## Test and run

From `apps/cli`, choose a command:

```sh
corepack yarn test                       # Full suite
corepack yarn test-grep "Graphite cloud"  # Matching tests
corepack yarn cli log --stack            # Local build
```

Run `corepack yarn check` and `corepack yarn lint` before submitting.
Building does not replace installed `gt`.

Command definitions live in `apps/cli/src/commands`. Build regenerates
`apps/cli/src/command_manifest.json`, a lightweight help/alias index that avoids
loading every action at startup. Commit that generated file when registration
metadata changes; tests check it against the actual command modules. Builders,
handlers, defaults, and validation are always loaded from the original modules.

## Output compatibility

Local command presentation targets native Graphite **1.8.6**. After building:

```sh
corepack yarn test:output                    # Checked-in native snapshots
corepack yarn test:output --graphite /absolute/path/to/native/gt
```

The regular test suite also checks these snapshots. Scenarios run in disposable
repositories with isolated homes, fixed commit dates, no credentials or remotes,
and disabled native tips. They compare ANSI bytes, whitespace, stdout, stderr,
and exit status separately; only temporary paths and relative ages are normalized.
Coverage includes navigation, create/modify and hooks, logs, PR display, worktrees,
tracking, freeze/unfreeze, restack, delete, info/diffstat, quiet/color modes, paging,
stack surgery (squash, fold, move, pop, absorb, unlink, undo), restack conflicts with
abort/continue, and refusals such as trunk-only operations.
Unit tests cover terminal pagers and structured debug output.

Paging follows native: a pager runs whenever interactive features are enabled,
even when stdout is redirected, and never under `--quiet`/`--no-interactive`.
`absorb` matches native by splitting staged work into zero-context hunks. Apply
those patches with `git apply --3way --unidiff-zero`: merging from their recorded
preimage avoids silently editing a different repeated line when history has
shifted line numbers.

To update the reference, change the shared scenarios in
`apps/cli/test/lib/output_scenarios.ts`, rebuild, then explicitly record **native**
output (never our implementation):

```sh
node apps/cli/scripts/parity/output.cjs --graphite /absolute/path/to/native/gt \
  --record apps/cli/test/fixtures/native_output.json
```

Do not strip ANSI or merge streams to make comparisons pass. Keep native quirks
such as `info`'s empty Children heading and Git-owned `log long`/diff output.
Backend-specific GitHub messages, help/product text, tip scheduling, and the
contents of implementation-specific debug traces are not byte-parity targets.
Never invent Graphite submission version numbers for GitHub-only PRs.

Stack surgery retains our clean-tree precondition: commands such as `move` and
`fold` refuse uncommitted tracked changes, even where native can proceed. Scenarios
clean the tree before those commands. Like native, `unlink` confirms before
dropping a PR association and fails in non-interactive mode.

Safety checks and GitHub Stack synchronization must not be weakened for parity.

## Backend switching

`gt-cli disable` is a native escape path. Its routing decision must not depend on
valid clone metadata, a successful export, SQLite, clone locks, or a healthy pinned
runtime. Keep the rescue coordinator dependency-free and preserve the shell-only
fallback. Normal migration still uses all ownership, backup, and CAS checks; never
force metadata writes merely to make disable succeed. Failed exports warn, retain
recovery state, and select native. Repeated disable must not replay stale exports
after native work. Explicit enable may clear native-only routing only after owner
validation or safe migration, and must not clear a newer concurrent disable selection.

Separate re-enable routing from runtime refresh. An existing valid `gt-gh` owner
with an unchanged native baseline needs no metadata handoff: pending journals and
busy repository locks must not trap it behind native routing. Preserve its pinned
runtime and every recovery artifact; never auto-abort or clear a journal merely
to enable. Runtime refresh uses nonblocking binding/stack locks and still requires
idle recovery state in every worktree. Previews probe existing lock inodes without
creating files. Queue retryable updates without changing other repositories' targets;
damaged/unknown recovery state requires explicit retry after repair, since an old
dispatcher may not understand that blocker. Native ownership changes and actual
migrations retain their full safety gates.

Cover corrupt repository/launcher state, busy locks, interrupted operations, missing
checkouts, broken runtime/build files, native binary upgrades, dry-run, idempotence,
and warning/JSON output. Scoped recovery should preserve other repositories when
possible; otherwise warn before restoring native globally. Missing native binaries
or genuine OS write failures must not be reported as success. Tests must never
change the developer's installed `gt`.

The regular suite includes ownership and compare-and-swap safety tests without a
proprietary CLI. Changes to enable/disable must also pass native-backed round trips:

```sh
GT_NATIVE_GRAPHITE=/absolute/path/to/native/gt corepack yarn test
```

Set `GT_NATIVE_GRAPHITE` to the actual Graphite **1.8.6** binary, not the managed
`gt` dispatcher. Without an available native binary, those integration tests are
skipped. Check the test summary rather than treating skipped handoffs as validated.
The tests isolate homes, PATH launchers, repositories, and native metadata; they do
not switch the developer's installed backend.

Native delete/untrack/rename remove dormant legacy metadata refs. With a verified
SQLite import snapshot, these refs are writer tripwires, not import data: accept
all removals, but reject additions/rewrites. Native can recreate/retrack the same
branch without recreating its legacy ref. Without a native database, require an
exact baseline match. Use the same backup for ownership checks and import;
preserve live snapshot checks, native validation, backups, and CAS during
application/recovery.

Regression coverage must include mid-stack untrack, delete then create with the
same name, and untrack then track. Native may retain child links to an untracked
parent. Import and export preserve those links without inferring tracking or
reparenting. Native validation must include `--show-untracked` so its lazy cache
also validates those branches. Allow `INVALID_PARENT` only along ancestry ending
at an existing untracked head; do not allow other validation failures, missing
heads, or cycles. Command preconditions still block edits to incomplete stacks.

## Graphite mirroring

Mirroring sends one existing-PR update per POST, sequentially in parent order,
matching native Graphite 1.8.6. The compatibility route's array-shaped schema does
not imply batch support: production rejects multi-PR payloads. Each request keeps
its own trunk identity.

Fresh GraphQL snapshots verify PR identities and optional GitHub Stack membership
before and after the POST sequence (50 PRs per query). For up to 50 selected PRs,
mirroring N changed PRs needs N POSTs plus two snapshot queries; an unchanged retry
needs only its preflight query. There are no per-POST snapshot reads. This checks
drift after the sequence, not between PRs: multiple PRs may have been affected
before drift is detected. No remote changes are rolled back.

Per-PR receipts retain their old fingerprints, including those from 0.6.16. Each
attempted PR is marked pending before its POST. The first failure stops later
POSTs without changing unattempted receipts. Postflight still runs after a failed
or ambiguous POST; verified earlier acknowledgements are checkpointed, so retries
skip those successes. Malformed replies and transport failures leave the affected
PR pending; failed postflight or drift leaves all attempted outcomes pending.
Retrying an ambiguous outcome can resend an already-applied update; receipts do
not guarantee exactly-once remote execution.

## Release

The root `README.md` is the canonical README for GitHub and npm. Release `prepack`
copies it to the generated, Git-ignored `apps/cli/README.md`; do not edit that copy.
Detailed CLI documentation lives in `apps/cli/USAGE.md`. README changes appear on
npm only after publishing a new version.

Publish the verified `@tianrendong/gt-cli` tarball with `--access public --tag latest`.
Never publish shared-types separately. Keep AGPL licensing and corresponding
source in every release.
