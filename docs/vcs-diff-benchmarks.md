## VCS Diff Benchmark Notes

This note captures the checkpoint diff benchmark results for the current branch so the performance gains remain documented even if parts of the implementation change during review.

### Workload

All numbers below use the same synthetic workload from the checkpoint diff benchmark harness.
The checked-in harness now runs each metric sequentially, not under `Promise.all(...)`, so the per-metric numbers are no longer distorted by contention between benchmark loops.

- `24` changed files
- `690,422` patch bytes
- `26,137` patch lines
- benchmark command for the `p99` measurements below: `bun run ... 60 5`

### Provenance

There are three comparison points:

1. `upstream/main` baseline
   - commit: `1bcfc88f589051c92882151788217c1410141ef7`
   - measured in a temporary worktree with a compatibility copy of the benchmark harness because `upstream/main` does not include the checked-in benchmark script
2. Branch state before the `VcsProcess.run` internal rewrite
   - commit: `e7d715ab0`
   - measured in a temporary worktree using the same checked-in sequential harness
3. Current branch state after replacing `VcsProcess.run` internals
   - measured from this workspace using the same checked-in sequential harness

### Mean Latency

| Metric                               | `upstream/main` | Branch before `VcsProcess.run` rewrite | Current branch after `VcsProcess.run` rewrite |
| ------------------------------------ | --------------: | -------------------------------------: | --------------------------------------------: |
| `vcsRegistry.resolve`                |        `0.04ms` |                               `0.07ms` |                                      `0.07ms` |
| `driver.checkpoints.diffCheckpoints` |             n/a |                             `294.15ms` |                                     `76.51ms` |
| `checkpointStore.diffCheckpoints`    |     `1179.81ms` |                             `384.44ms` |                                     `72.18ms` |
| `checkpointDiffQuery.getTurnDiff`    |     `1649.32ms` |                             `383.86ms` |                                     `61.45ms` |
| `parseTurnDiffFilesFromUnifiedDiff`  |       `12.42ms` |                              `12.40ms` |                                     `13.16ms` |

### Tail Latency (`p99`)

| Metric                               | `upstream/main` | Branch before `VcsProcess.run` rewrite | Current branch after `VcsProcess.run` rewrite |
| ------------------------------------ | --------------: | -------------------------------------: | --------------------------------------------: |
| `vcsRegistry.resolve`                |        `0.08ms` |                               `0.84ms` |                                      `0.19ms` |
| `driver.checkpoints.diffCheckpoints` |             n/a |                             `456.42ms` |                                    `244.11ms` |
| `checkpointStore.diffCheckpoints`    |     `2262.90ms` |                            `1297.82ms` |                                    `374.22ms` |
| `checkpointDiffQuery.getTurnDiff`    |     `2937.21ms` |                            `1169.40ms` |                                    `220.43ms` |
| `parseTurnDiffFilesFromUnifiedDiff`  |       `16.43ms` |                              `21.03ms` |                                     `17.95ms` |

### Key Deltas

#### Gains already achieved before the `VcsProcess.run` rewrite

Compared with `upstream/main`:

- `checkpointStore.diffCheckpoints`
  - `1179.81ms` -> `384.44ms`
  - `67.4%` lower mean latency
  - `3.07x` faster
- `checkpointDiffQuery.getTurnDiff`
  - `1649.32ms` -> `383.86ms`
  - `76.7%` lower mean latency
  - `4.30x` faster

This is the number set to preserve if the `VcsProcess.run` rewrite is rejected but the earlier checkpoint/VCS restructuring is kept.

#### Additional gains from replacing `VcsProcess.run` internals

Compared with the branch state before the rewrite:

- `driver.checkpoints.diffCheckpoints`
  - `294.15ms` -> `76.51ms`
  - `74.0%` lower mean latency
  - `3.84x` faster
- `checkpointStore.diffCheckpoints`
  - `384.44ms` -> `72.18ms`
  - `81.2%` lower mean latency
  - `5.33x` faster
- `checkpointDiffQuery.getTurnDiff`
  - `383.86ms` -> `61.45ms`
  - `84.0%` lower mean latency
  - `6.25x` faster

Compared directly with `upstream/main`:

- `checkpointStore.diffCheckpoints`
  - `1179.81ms` -> `72.18ms`
  - `93.9%` lower mean latency
  - `16.34x` faster
- `checkpointDiffQuery.getTurnDiff`
  - `1649.32ms` -> `61.45ms`
  - `96.3%` lower mean latency
  - `26.84x` faster

### Notes

- Diff parsing is not the bottleneck. It stays around `12-13ms` mean across all three states.
- `vcsRegistry.resolve` is effectively unchanged in the steady state once measured sequentially. The earlier `~11ms` rows were artifacts from running all benchmark loops concurrently and letting the cache TTL expire mid-run.
- The biggest user-visible win is on `checkpointDiffQuery.getTurnDiff`, which is the closest proxy here for “open diff view” and “change turns, then wait for diff data”.
- `upstream/main` does not expose `driver.checkpoints.diffCheckpoints`, so that row only exists for the two branch states.
