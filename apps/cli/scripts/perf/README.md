# Local CLI performance

## What was worth changing

- **Batch metadata contents:** bounded `git cat-file --batch` reads replace one
  process per metadata ref. The existing combined head/metadata _ref enumeration_
  is retained, not counted as a new optimization.
- **Reuse immutable ancestry validations:** after a cache-seed change, reuse
  successful, non-repairing validations whose branch tip, parent name, recorded
  parent revision and current parent tip still match. Rebuild graph membership,
  parent validity, cycles, PR metadata and child lists normally.

This is incremental **ancestry validation**, not an O(changed-branches) cache for
all graph work. Ref enumeration, batched metadata reads and graph reconstruction
still scale with repository size. No language rewrite was needed for these wins.

## Measurements

Baseline: **0.6.18 / `534fa68b`**, including the previously landed safe-read
optimizations. Apple M4 Max, macOS arm64, Node **22.23.2**, Git **2.54.0**.

Below: median wall time, fresh Node process through **`gt_cli.js`**, not direct
`index.js`. Native ownership checks enabled. Fixtures have 50 tracked feature
branches plus `main`, arranged in five-branch stacks. Nine timed pairs per case,
except the 31-pair warm follow-up. These are isolated Git fixtures, not timings
from a user's working repository or an installed shell launcher.

| Operation / starting state         | Baseline | Candidate |   Speedup | Git processes |
| ---------------------------------- | -------: | --------: | --------: | ------------: |
| `log short`, full cache removed    |  1123 ms |    725 ms | **1.55×** |      107 → 59 |
| `log short`, one PR title changed  |  1144 ms |    259 ms | **4.43×** |       107 → 9 |
| `log short`, one leaf tip changed  |  1142 ms |    273 ms | **4.18×** |      107 → 10 |
| `create`, after PR metadata change |  1380 ms |    481 ms | **2.87×** |      144 → 29 |
| `create`, full cache removed       |  1387 ms |    942 ms | **1.47×** |      144 → 87 |
| `create`, warm cache               |   442 ms |    447 ms |     0.99× |       26 → 26 |
| `log short`, warm cache, 31 pairs  |   228 ms |    230 ms |     0.99× |         6 → 6 |

Creation cases start with 50 feature branches, then add a branch/commit per
sample. Process counts come from a separate final traced run, after those timed
creations. Both implementations receive identical changes and commit dates.

**Scaling, 200 feature branches, five timed pairs, same native checks:**

| `log short` state    | Baseline | Candidate |    Speedup | Git processes |
| -------------------- | -------: | --------: | ---------: | ------------: |
| Full cache removed   |  3850 ms |   2122 ms |  **1.81×** |     407 → 211 |
| One PR title changed |  3861 ms |    377 ms | **10.25×** |      407 → 11 |
| One leaf tip changed |  3904 ms |    380 ms | **10.27×** |      407 → 12 |

**Ablation:** identical candidate build with the optional validation cache omitted
from `parseBranchesAndMeta`. Metadata batching remains enabled. At 50 branches,
with native checks and seven pairs, a PR-title change improved **1155 → 679 ms
(1.70×)**, with **107 → 58** Git processes. Batching helps; validation reuse
provides the larger improvement after changes. Do not multiply these ratios.

**No consistent warm-path win.** The initial nine-pair warm sample was 222 →
236 ms; the 31-pair follow-up was 228 → 230 ms. Warm `create` is also unchanged.
Median improvements are not tail-latency guarantees: cold-create p90 in the
nine-pair run was 1820 → 1848 ms. Samples, p90s, process counts and runtime-build
fingerprints are retained in [measurements.json](measurements.json).

## Method and limits

- Independent baseline/candidate builds and repositories; alternating execution
  order; successful exits and identical stdout/stderr required.
- Every scenario starts from the same fixture. Each implementation primes its
  own cache twice. “Cold” means **persisted graph cache removed**, not cold OS
  page cache; code and filesystem are warmed.
- Ref values, metadata repairs, HEAD, worktree/index status and local stack/sync
  files must agree. Native database bytes must remain unchanged.
- `--native-db` creates an **empty synthetic SQLite database** and local binding
  to exercise both ownership checks. It is not a production native database or a
  native Graphite migration benchmark. Native Graphite parity is tested separately.
- HOME, Git configuration and credentials are isolated. `gh`, `curl` and `wget`
  fail in the fixture; proxies point to unreachable loopback. Commands are local;
  no live publication tests are performed. This is not an OS network sandbox.
- Process counts use a separate Git Trace2 sample, never the timed samples.
  Runtime fingerprints cover compiled JS/CJS/JSON, excluding tests, source maps
  and benchmark scripts. Original measured whole-build digests are also retained.
- Empty-tree fixture histories isolate frontend/subprocess work. Large working
  trees, deep histories, hooks, real database contents and network latency can
  change end-to-end results. These numbers do **not** predict remote-submit gains.

## Correctness boundaries

- Metadata batches use byte lengths, legacy UTF-8/trim/schema behavior, bounded
  buffers and singleton fallback for failed/truncated batches or non-blob refs.
  Git still resolves loose/packed refs, replacement objects and object storage.
- Reused validations use fully resolved commit IDs, not mutable branch names.
  Short-name ambiguity retains normal Git validation. Only successful results
  that did not repair metadata are saved; invalid-parent and cycle checks run
  before proof reuse. Changed inputs revalidate through Git.
- Shallow history, grafts, replacement refs, custom object/namespace overrides,
  alternates and promisor packs disable reuse, including full-cache hits.
  Unexpected filesystem errors fail closed. No mtime/size cache substitutes for
  these checks. Proofs cannot be stamped reusable merely because an override
  disappears between load and persist.
- Bump `VALIDATION_CACHE_VERSION` when validation rules change. Ordinary package
  version changes need not discard proofs about the same immutable commits.
- Hooks, signing, rebase/replay, journals, undo, locking and both native ownership
  checks remain in place. GitHub/Graphite transport code is unchanged; Graphite
  writes remain sequential singleton requests.
- The native parity suite had a stale pre-0.6.18 batched-mirror expectation.
  Its expected sequence is corrected to parent, child, retried child singleton
  requests. The corrected regression also passes against unchanged baseline code.

## Validation

- Lint and TypeScript build passed on Node 22.23.2.
- **749 tests passed**, including native Graphite 1.8.6 parity; one existing
  non-UTF-8-filename test is pending on APFS. The network-cloning
  `large_repo.test.js` file was excluded.
- Focused coverage includes metadata framing/fallbacks, Unicode/BOM/whitespace,
  malformed metadata/cache records, tracing, ref ambiguity, parent changes,
  cycles, orphan cleanup, auto-repair, history overrides, linked worktrees,
  SHA-256 and reftable repositories.
- The corrected singleton-mirror regression also passed against the unmodified
  0.6.18 runtime, independently of these performance changes.

```sh
cd apps/cli
GT_NATIVE_GRAPHITE="$NATIVE_GRAPHITE_1_8_6" \
  node ../../node_modules/mocha/bin/mocha.js 'dist/test/**/*.test.js' \
  --ignore 'dist/test/large_repo.test.js' --parallel --jobs 4
```

## Reproduce

Build both source trees with the same Node 22.x and locked dependencies. Use
0.6.18 (`534fa68b`) as control, not an older installed executable or a dispatcher
bound to some other installation. From this repository's root:

```sh
node apps/cli/scripts/perf/local.cjs \
  --baseline "$CONTROL/apps/cli/dist/src/gt_cli.js" \
  --candidate "$PWD/apps/cli/dist/src/gt_cli.js" \
  --branches 50 --runs 9 --native-db --mutations \
  --output /tmp/gt-perf.json
```

Use `--branches 200 --runs 5` for the larger fixture, or
`--scenarios warm --runs 31` for the warm follow-up. Without `--native-db`, there
is no native database/binding. Without `--mutations`, only inspections run.
Creation scenario selection requires `--mutations`.

For the batching-only ablation, copy the compiled candidate tree and change the
single `historyAtLoad ? validationCache : undefined` argument in
`dist/src/lib/engine/cache_loader.js` to
`undefined /* ablation: metadata batching only */`. Keep dependencies available
and run the same harness against that copy. Do not modify the timed baseline or
alternate builds against one shared persisted cache.
