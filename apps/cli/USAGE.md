# @tianrendong/gt-cli

Use **`gt`** for repository initialization and GitHub PR stacks; **`gt-cli`** for
installation, implementation selection, and settings.

**Before setup or backend switches:** pause competing stack commands across
affected worktrees. Updates do not require pausing commands. Keep native
Graphite at **1.8.6** for validated metadata migration. Disable can return to
other installed native versions too, with a warning when migration is unavailable.

Requires macOS or glibc Linux, Git, npm (Node 18+), and a writable,
user-owned `gt` location on PATH. The installer manages runtime dependencies.

## Install

Run outside the gt-cli source checkout:

```sh
npx -y @tianrendong/gt-cli@latest install && gt-cli enable --global
```

Selects our implementation globally only after installation succeeds.

## Repository initialization and implementation selection

From 0.6.8, implementation selection does **not** initialize or enroll fresh repos:

- `gt-cli enable --global` selects the default implementation.
- `gt-cli enable --repo PATH` selects our implementation for that repository only.
- `gt-cli disable --repo PATH` selects native Graphite for that repository only.
- `gt init --trunk main` explicitly initializes a fresh repository for stack work.
- `gt track` adds an existing branch to an initialized repository's stack metadata.

With our implementation selected, repository commands in an uninitialized checkout
fail with an instruction to run `gt init`. There is no implicit trunk selection
from `info`, `log`, or mutating commands. Help/version do not enroll a checkout;
`gt init --help` is also safe. Legacy `gt repo init` remains supported. Native
Graphite retains its own command behavior when selected.

Per-repo implementation overrides are stored separately from initialized-repository
handoff registrations. Selecting an implementation for a fresh checkout does not
write its Git configuration, branch refs, cache, or migration state. Existing
initialized native repositories still receive validated metadata handoff when
switching implementations; that converts existing setup rather than authorizing
new setup. Existing registrations and interrupted operations are not erased.

Global disable returns control to native Graphite even when gt-cli state is broken.
Metadata handoff is best-effort: healthy repositories migrate safely, while failures
produce warnings and retain recovery data. Explicit native opt-outs survive subsequent
global enable. Selector-only overrides do not enter the binding-update/handoff list.
`gt-cli forget` can remove a deleted selector-only checkout's override explicitly,
without having enrolled it.

## Update

```sh
gt-cli update
```

Installs the latest release without interrupting running commands. Idle repositories
switch immediately. Busy repositories keep their current version; **the next `gt`
command after the operation finishes switches automatically**. No second update is
needed. A paused operation keeps its version through `gt continue` or `gt abort`,
including across linked worktrees.

Deleted, moved, or offline **linked checkouts** do not block updates when their
retained Git metadata is idle. Safety checks inspect each worktree's administrative
Git directory, not its checkout path. Updates never prune worktree registrations,
delete recovery metadata, or change branch refs. Paused operations in missing
checkouts still keep their version; restore the checkout to finish or abort them.

**Deferred** means a running command or paused operation must finish first.
**Blocked** means an activation error needs repair, such as inaccessible or invalid
metadata. Blocked repositories keep their current version, and subsequent `gt`
commands warn on stderr while retrying. After repair, the next command switches
without another update. **Missing** means a registered Git directory is absent but
automatic cleanup was unsafe (for example, a volume may be unmounted). Output
explains why its registration was kept. Checkouts that
pass cleanup checks are automatically forgotten rather than
reported as blockers. An installed release is not necessarily active in every
repository; output reports pending bindings separately.

All `gt-cli` management commands use **green** for success, **red** for errors,
**yellow** for warnings, and **cyan** for progress, previews, and commands. Supporting
details are dimmed; intentionally disabled settings stay neutral. JSON and
`--status` selection output stay uncolored. Pipes are plain by default;
`FORCE_COLOR=1` enables color explicitly, while `NO_COLOR` always disables it.
This does not change `gt` output.

Unavailable repositories retain their registrations unless their Git directory is
absent and the filesystem checks below allow automatic cleanup.
Old version directories are kept for running commands and recovery; do not delete
them. Native Graphite opt-outs and global mode are unchanged. Download, integrity,
and conflicting installation errors still fail rather than silently claiming success.

### Update notifications

Managed installations check npm's `@tianrendong/gt-cli@latest` during interactive `gt`
use, at most once every six hours. Checks run in a detached process using the
installed private npm runtime and your existing npm authentication/proxy settings.
They fetch version metadata only: no packages are installed and no repository
bindings change. Commands never wait for the network.

The first eligible command schedules a check. A subsequent successful command
can show a cached result on stderr, without changing stdout or its exit status:

```text
gt-cli update available: 0.6.30 → 0.6.31
Run `gt-cli update` to install.
```

These are example versions. A new stable release is announced once, then at most
once daily while it remains newer than the installed management `current` release.
An older repository version retained for a busy or paused operation does not
trigger another update reminder. Results older than 24 hours are not advertised.

Checks have a five-second timeout and no network retries. Offline/authentication,
cache, and subprocess errors stay silent and back off for one hour; run
`gt-cli update` explicitly for actionable update errors. Notification state lives
in `update-notifier.json` alongside `current` in the installation home (default
`~/.local/share/gt-cli`), separately from activation's `update.json` checkpoint.
Concurrent terminals share checks and reminder receipts.

CI, redirected stdin/stdout/stderr, `--quiet`, `--no-interactive`, JSON output,
help/version/completion/internal commands, native Graphite, and source-development
runs do not check or notify. To disable both checks and reminders in your shell:

```sh
export GT_CLI_NO_UPDATE_CHECK=1
```

`NO_UPDATE_NOTIFIER=1` also disables them. Existing installations need one manual
`gt-cli update` to receive notification support; inactive users are not notified
until they use `gt` again.

### Deleted checkout registrations

From **0.6.29**, updates and global enable/disable automatically forget deleted
checkout registrations, including explicit enables and non-temp paths such as `~/tools`.
The old adopted-temp-only restriction no longer applies. From **0.6.30**, a gone
Git directory means a gone repository: leftover working files or linked worktree
directories without their Git metadata no longer keep a registration. Cleanup requires:

- The registered Git directory is absent with plain `ENOENT`. A relocated `.git`
  file, symlinked or unreadable ancestors, and invalid paths are protected.
- Its nearest existing ancestor is on the recorded filesystem. From **0.6.34**, the
  filesystem is identified by its mount point, which survives reboots. A different
  mount point (for example `/` instead of a recorded `/Volumes/Backup`) can mean a
  volume was unmounted, so the registration stays intact. Mount points are recorded
  at enable/adoption and refreshed during successful update inspection.
- Records written before 0.6.34 identify the filesystem only by device number.
  macOS assigns APFS device numbers at mount time, so every recorded device is
  stale after a reboot. Such a record is still cleaned up when it matches the
  current device, or when another registered path that still exists as a plain
  directory on the current filesystem recorded the same stale number (proof of a
  renumbering rather than an unmount). Updates evaluate cleanup before refreshing
  surviving registrations, because refreshed observations replace that proof.
- Older records without a recorded device use the recorded temporary-root device,
  or the current device of a containing HOME/temp root. Unknown paths outside
  those roots stay protected until explicitly forgotten.

These checks are a heuristic, not proof of permanent deletion. A different volume
mounted at the same mount point, or a legacy device number reused by another volume
between a reboot and the next update, is indistinguishable from the original
filesystem. Legacy records cannot identify a former mount nested under HOME/temp.
Cleanup never deletes repository or leftover files; if the Git
directory returns, the checkout re-registers on its next `gt` command as described
below.
Validated handoffs preflight remaining repositories before removing registrations.
If global disable cannot complete that handoff, it restores native routing anyway,
archives available launcher records, and leaves repository recovery data in place.
`--dry-run` lists planned cleanup or recovery warnings without changing registrations
or writing backups.
A fresh checkout still enters the handoff list only through explicit `gt init`;
first-use handoff remains possible for already-initialized repositories.

For a permanently deleted checkout that stays protected:

```sh
gt-cli forget --repo /absolute/path/to/deleted/repo --dry-run
gt-cli forget --repo /absolute/path/to/deleted/repo
```

To clean up every stale registration at once (each one still has to pass the same
per-repository check: Git directory definitely absent):

```sh
gt-cli forget --missing --dry-run
gt-cli forget --missing
```

The exact registered Git-directory path is also accepted. Forget refuses existing,
relocated, or unreadable Git directories; `--missing` simply skips them.
It removes only the saved registration and pending-update intent; it does not
delete files, disable a backend, or replace the gt executable. Use
`gt-cli disable --repo PATH` for a live repository. Explicit forgetting bypasses
only the filesystem-identity guard: confirm missing paths are permanently deleted,
not on an offline volume. Existing and unreadable paths still cannot be forgotten.
Global enable refuses while any remaining registration is unavailable and reports
all of them in one message. Global disable warns instead and restores native routing;
an offline or damaged checkout cannot keep other developers on gt-cli.

Automatic and explicit forgetting remove the registration from the launcher
record without keeping a backup; output lists each forgotten checkout.
If a moved/restored checkout returns still selecting gt-gh **while the dispatcher
is active**, its first `gt` command re-registers it and queues a binding refresh.
Busy operations retain their pinned version; native metadata drift still blocks
refresh. Neither path changes backend selection or overwrites native metadata.
If native routing was restored by global disable, inspect the returned checkout
and explicitly enable it again before relying on global handoff.

If an updater older than 0.6.5 is stuck resuming an old release, run
`npx -y @tianrendong/gt-cli@latest install` outside the source checkout, then `gt-cli update`.
The newer updater checks npm before resuming and supersedes obsolete checkpoints.

## CLI backend

Choose one:

```sh
gt-cli enable
gt-cli disable    # Return to native Graphite
```

Default: current repository and its worktrees. Add `--repo PATH` or `--global`.
Global disable returns **all repositories** to native Graphite, automatically
forgetting deleted checkouts that pass the normal cleanup checks above.

### Disable is an escape path

`gt-cli disable` must let you leave gt-cli regardless of its internal state. It first
attempts the usual guarded metadata handoff. Busy locks, paused operations, malformed
state, metadata drift, unsupported migration versions, broken runtimes, or failed
validation do not prevent native selection. Migration has a bounded time budget;
a timed-out migration worker and its child writers are stopped before returning.
Running commands started independently are **not** killed.

If handoff cannot finish, disable prints warnings and repair hints, preserves branch
refs, working files, operation journals, and switch backups, then selects native
Graphite without forcing unsafe metadata writes. Native stack metadata may be stale
or incomplete: inspect `gt log` and use native `gt init` / `gt track` as needed before
restack or submit. Stop running clone commands before native mutations. A paused
clone operation may need its original runtime to recover, so keep old installations
and journals; do not blindly replay backups over newer native work.

Native routing overrides retained clone state and does not take clone locks.
Repeated disable does **not** retry a failed export after control has passed to
native Graphite. Explicit `gt-cli enable` may clear the native-only selection after
validating the existing clone owner, or after a safe metadata migration. Recovery
can still require manual metadata reconciliation before re-enabling; it never
blocks using native Graphite.
If scoped enable reports unfinished launcher bookkeeping after a shell-only or
interrupted escape, rerun `gt-cli disable --global` with a working runtime first.
That repairs routing records without replaying old exports.

Per-repository selection normally leaves other repositories alone. If that scoped
selection cannot be saved, or launcher registrations are unreadable, disable warns
and restores native routing **globally** instead. With no usable Node runtime, the
shell-only rescue also restores native globally using the preserved executable link.

`--json` reports `handoff: "complete" | "incomplete"` and a `warnings` array separately
from native selection. `--dry-run` previews both routing and warnings without making
changes. Invalid arguments, missing/unusable native Graphite, an unwritable PATH
entry, or an unrelated concurrent executable replacement can still fail honestly;
exit zero must not claim a switch that could not be made. No `--force` is needed.

### Re-enable without blocking clone recovery

If disable could not hand off metadata, the saved owner may still be `gt-gh`.
When that ownership is valid and native metadata is unchanged, `gt-cli enable`
restores clone routing without requiring the pending operation to finish first.
It warns about paused operations, unfinished rollback, or damaged journals rather
than deleting them or interpreting them as completed work. Running commands and
busy repository locks do not delay this routing-only path.

The existing runtime stays pinned while recovery is unfinished. Use `gt continue`
or `gt abort` deliberately in the worktree that started the operation; re-enable
itself does neither, and never resets refs, the index, or working files. Reconcile
any work done in native Graphite before attempting recovery. A leftover `sync`
journal does not by itself prove that abort or journal removal is safe.

Runtime updates deferred for busy operations normally retry on a later `gt` command
once recovery finishes. Damaged or unsupported recovery state requires repair,
then another `gt-cli enable`; an older dispatcher must not attempt an update using
checks that do not understand the blocker. An explicit request for a different
runtime also never retargets an update queued for another repository; follow the
retry hint if the requested version remains deferred.

`--json` reports `selectionOnly: true`, the selected (or previewed) `candidate`, and
optional `bindingDeferred`, `bindingBlocked`, and `warnings` fields. Success means clone
routing was selected, **not** that a journal was cleared or recovery completed.
Global enable reports retained-runtime repositories in `deferred`, continues
healthy binding updates, and preserves explicit native opt-outs. Routing-only
`--dry-run` previews change no routing, bindings, or journals and create no lock files.

A real native-to-clone metadata migration still requires idle worktrees and all
ownership checks. Native metadata drift, invalid saved ownership, an unavailable
recovery runtime, and filesystem errors remain failures, not force-bypass cases.
Launcher contention or a busy migration lock fails promptly with a retry hint
rather than waiting behind another command.

### Switch safety and diagnostics

Switches import the current owner's stack metadata, not an old snapshot of branch
heads. Native Graphite's delete, untrack, rename, and merged-branch cleanup can
remove dormant `refs/branch-metadata/*` refs left by our implementation. With a
verified native SQLite snapshot, re-enable accepts all such removals and rebuilds
metadata from SQLite—not from the dormant refs. This includes a branch later
recreated or retracked with the same name.

Mid-stack untrack may leave children pointing to a surviving untracked parent.
Handoffs preserve those links, published versions, and frozen state without
retracking the parent or reparenting its children. Track the parent explicitly
before changing that stack. Missing branch heads still require the separate,
explicit missing-parent recovery workflow; dormant refs never resurrect them.

Added or rewritten dormant refs still block re-enable. Without a native database,
the saved ref baseline must match exactly. Native database/config/cache changes
while our implementation owns the repository also block metadata export, but **not
native routing on disable**. Diagnostics identify the repository, conflicting refs
or files, and backup directory. There is no unsafe metadata-write bypass: do not
delete switch state, edit its saved baseline, or restore stale refs to silence an
ownership error.

Inspect without switching:

```sh
gt-cli enable --repo PATH --dry-run    # Preview routing, runtime update, or migration
gt-cli disable --repo PATH --dry-run   # Preview native routing and handoff warnings
gt-cli enable --repo PATH --status    # Selection only, not a readiness check
```

Pause competing commands across all linked worktrees before a metadata migration.
Routing-only re-enable does not require an idle clone. Resolve reported conflicts
against the current owner's metadata, then retry the preview.
Backups, SQLite/ref compare-and-swap checks, and interrupted-switch recovery remain
in force for migration. Previews never change implementation selection or branch
tips. A disable preview can report incomplete handoff while still showing that
native routing can be restored.

## Sync output

From **0.6.27**, `gt sync` prints the same sections in the same order as native Graphite 1.8.6:
fetch results; a cleanup section only when it finds cleanup candidates (merged
or closed PRs it cannot delete because another worktree has them are reported
as `WARNING: PR #N for BRANCH is merged but cannot be cleaned up while ...`); a
`🔄 Syncing branches...` section listing branches with open PRs that are up to
date with, or were updated from, the remote; and a restack section only when it
has branches to process. Restack results (including unchanged and frozen
branches, and branches left alone because another worktree has them checked
out) remain visible inline. Routine explanations about keeping unpublished
local commits or amends are available with `gt sync --debug`, not printed for
every branch by default. Remote divergence warnings and the closing list of
branches that could not be restacked cleanly stay visible.

## Sync performance

From **0.6.27**, sync makes one fetch: GitHub already reports each open PR's head commit, so no
separate remote listing is needed, and stale remote-tracking refs are pruned
while PR information is read. Branches are rewritten with plumbing, without a
checkout. A branch whose rebase would conflict is detected from the merge result
alone and listed for `gt restack`; no working-tree rebase is started and aborted
for it. Unchanged PR metadata is not rewritten. Branches with open PRs are not
scanned for merged history; only branches without a PR are.

From **0.6.41-beta.1**, sync compares branches with their remote heads in
parallel. Each check (`git rev-list --left-right --count`) reads only commit
IDs and is slow in shallow clones, where git ignores the commit-graph. Checks
run at most 4 at a time, never on more than half the cores. All checks finish
before any branch is changed, and results are applied and printed in the same
order as before. Set `GT_SYNC_CONCURRENCY` to override the limit;
`GT_SYNC_CONCURRENCY=1` runs the checks one at a time.

## Sync conflicts

Like native Graphite, `gt sync` restacks branches that can be updated without
conflicts. If a branch conflicts, sync leaves it unchanged, continues with other
branches, and lists the branches that need attention. Successful pulls, branch
cleanup, and restacks are kept; sync does not leave a rebase in progress.

To resolve a reported conflict when you are ready:

```sh
gt checkout BRANCH_NAME
gt restack
```

Explicit `gt restack` enters conflict resolution. Resolve and stage the files,
then run `gt continue`, or use `gt abort` to cancel that restack without undoing
the earlier sync.

### Branches that share no history with their parent

A branch can end up with no commit in common with its parent: trunk was reset to
unrelated history, the branch was started from an unrelated root, or its recorded
parent commit is no longer reachable. From **0.6.28**, gt reports that branch as
`(needs restack)` like native Graphite and keeps every other command working,
including read-only commands and the `gt restack` that repairs it. Earlier
versions failed every command in the repository with a raw `git merge-base`
error, leaving no way to repair the branch from gt.

`gt track` still refuses a parent that shares no history with the branch, naming
both branches; rebase onto that parent first.

## Concurrent commands and worktrees

Stack commands in different worktrees can run concurrently (**0.6.21+**):
ordinary stack commands no longer share a repository-wide lock. `gt sync`
updates trunk without checking it out, then restacks the current and affected
stacks (all stacks when run from trunk). Their branches may be checked out
elsewhere:

- Trunk is fetched and fast-forwarded without switching branches. If another
  worktree has trunk checked out, that worktree is fast-forwarded in place
  (HEAD, index, and files together). Git refuses if the update would overwrite
  a modified file there; `gt sync` then reports it and continues with the
  current local trunk.
- A branch checked out in another worktree is restacked there: its rebased
  commits are computed here, then that worktree moves to them with
  `reset --keep`. This requires that worktree to have no running gt command,
  no paused git operation, and no uncommitted tracked changes. Untracked files
  are preserved; Git refuses updates that would overwrite them. Otherwise sync
  prints `Did not restack branch X because it is checked out in worktree P,
  which ...` and leaves it as is, along with its descendants; run `gt restack`
  from that worktree when convenient. A conflicting rebase is also left to that
  worktree and listed with its location; nothing is stashed or rewritten there
  on failure.
- Sync checks other worktrees without waiting. When another worktree is busy
  at planning time, its stack is excluded from deletion, reparenting, remote
  branch updates, and restacking; unrelated stacks continue. Run sync again
  after that command finishes. Each cross-worktree move also takes the owning
  worktree's lock nonblockingly and checks the expected old commit before
  moving files. These guards do not make arbitrary simultaneous operations on
  the same stack transactional; avoid intentionally editing the same stack
  from multiple worktrees at once.
- A merged branch checked out in another worktree is not deleted from here;
  `gt sync` says so. Deleting the current branch lands on its parent, or detached
  at the parent's commit when another worktree has the parent checked out.
- Metadata refs are shared. Engine updates use compare-and-swap; when another
  command changed a branch's metadata meanwhile, only the fields this command
  meant to change are applied on top (per PR-info field). Metadata reads use
  captured blob IDs. The persisted cache is marked reusable only when its
  branch heads and metadata blobs match a fresh ref snapshot.

- GitHub stack records are shared (**0.6.41-beta.2+**). gt remembers the
  composition it last synchronized for each GitHub stack, which is how it
  tells its own earlier submit from an edit made on GitHub. That record now
  lives once per repository, one file per stack, in
  `<common-git-dir>/gt-github-stacks/`, so any worktree can reorder, fork, or
  rebuild a stack another worktree created. Files are replaced atomically and
  never locked: agents on different stacks never wait for each other. If two
  worktrees submit the same stack at once, the last write wins; a record left
  behind GitHub makes the next submit refuse rather than overwrite. Cleanup
  replays (unstack, then rebuild survivors) take a per-stack claim without
  waiting; a stack being cleaned up elsewhere is skipped and retried on the
  next submit or sync. The first command after upgrading merges every
  worktree's old record: agreeing records are kept, and where worktrees
  disagree gt accepts whichever one GitHub still matches. Each worktree's
  `gh-stack` file and last export stay per worktree, and gt keeps writing the
  old per-worktree record so a downgrade keeps working.

Within one worktree, commands that change branches or metadata still share the
worktree's stack lock (the same `flock` gh-stack uses). A second such command in
the same worktree waits; after one second a notice appears on stderr, and Ctrl-C
cancels the waiting command without interrupting the holder. Read-only commands
(`gt log`, `gt ls`, `gt info`, `gt parent`, `gt children`, `gt trunk`,
`gt state`, `gt pr`, `gt github status`) never wait: while another command holds
the lock they show the current local view without changing stack metadata, and
when the lock is free they reconcile the gh-stack mirror, then release it before
printing, so an open pager never blocks anyone.

The repository-wide `gt.lock` is used by metadata handoffs, binding updates, and
managed native dispatch. Disable does not wait on busy clone locks: it skips unsafe
export and restores native routing with a warning. Native-only escape routing
bypasses those locks. Do not delete `gt.lock`, `gh-stack.lock`, or
`gt-cli-binding.lock`; locks are released automatically when the owning process
exits.

### Abort and undo across worktrees

Run `gt abort` or `gt undo` in the worktree where the operation started; its
journal and continuation belong there. From **0.6.26**, recovery also reverses
that command's cross-worktree moves, restoring each owning checkout's branch,
index, and files together. Older operation journals remain recoverable.

A journal lives in its own worktree's Git directory, so from **0.6.28** a
relocated checkout keeps working: `git worktree move`, a renamed or copied
repository, and worktree pools that rename checkouts between tasks adopt the
journal at its new path. Earlier versions rejected every mutation there,
including the `gt undo` and `gt abort` needed to clear the journal.

Recovery checks all affected worktrees before moving any: busy, paused, missing,
or dirty checkouts block it, as do commits or metadata changed after its checkpoint.
Owning worktree locks stay held through ref and metadata restoration. Untracked
files are preserved; if Git rejects a later checkout update, earlier completed
rollback moves are checkpointed. Resolve the blocker and retry the same recovery
command in the original worktree. New mutations and `gt continue` are blocked
once a rollback has started. Do not delete journals or use raw Git commands to
bypass recovery guards.

## When submit refuses to rebuild a GitHub stack

A reorder, removal, insertion, base change, or fork can only be published by
dissolving a GitHub stack and creating it again. gt does that only when GitHub
still has exactly what gt last synchronized; otherwise it refuses before
pushing anything, and says which case applies:

- **"GitHub stack #N changed on GitHub since gt last synced it"**: someone (or
  `gh stack`, or the web UI) edited it. The message shows both versions. Run
  `gt get N` to adopt GitHub's version, then repeat your local change.
- **"gt has no record of syncing #N in this repository"**: the stack was last
  submitted from another clone, by `gh stack`, or by gt before 0.6.41-beta.2.
  If GitHub's version (shown in the message) is what you last submitted, run
  `gt submit --stack --reconcile local`; otherwise `gt get N` first.
- A local **fork** inside a GitHub stack is named in the message. GitHub stacks
  are linear, so gt rebuilds the forked stack as separate stacks with new
  numbers.

Agents should follow the message or ask. Do not add `--no-stack-sync` to get
past a refusal: it stops syncing GitHub stacks altogether and falls back to
dependency trees in PR bodies.

## Stack cleanup

`gt delete` and `gt fold` remove discarded branches' PRs from native GitHub
stacks. `gt sync`, `gt submit`, and `gt github sync` also prune closed,
unmerged PRs and repair deferred branch deletions. GitHub-side closures are
picked up on the next sync; no background watcher runs.

```sh
gt github sync --dry-run    # Preview membership cleanup
gt github sync              # Repair without pushing Git branches
```

GitHub requires rebuilding stacks to remove members, so stack numbers may
change. Open PRs and their bases are preserved; disconnected survivors become
separate stacks, single survivors become standalone PRs, and merged history
stays on GitHub. Failed cleanup is resumable with `gt github sync` after
resolving API errors or merge locks. Use `--no-stack-sync` on delete/fold to
defer remote cleanup until a later sync.

## Graphite submission

Experimental, off by default. Choose an action (**0.6.1+**):

```sh
gt-cli graphite enable
gt-cli graphite disable
gt-cli graphite status
gt-cli graphite reset    # Remove override; inherit global default
```

Same scope flags; repository overrides win. GitHub submission is unchanged.
Requires GitHub.com and native Graphite sign-in or `GT_GRAPHITE_TOKEN`.

[Scope and recovery](https://github.com/tianrendong/gt-cli/blob/main/docs/cutover.md) · [Contributing](https://github.com/tianrendong/gt-cli/blob/main/CONTRIBUTING.md)

**AGPL-3.0-only**. Packages include corresponding source in `source.tar.gz`.
Based on [gt-gh](https://github.com/tianrendong/gt-gh) and
[Charcoal](https://github.com/danerwilliams/charcoal).
