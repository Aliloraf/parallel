# @aliloraf/parallel-engine

The **Parallel** engine: systematically explores the interleavings of a
scenario's checkpoints, checks invariants, records failure traces and replays
them deterministically. Use it to run scenarios from your own test runner
(`node:test`, Vitest, Jest, ...). For the command line, use
[`@aliloraf/parallel-cli`](https://github.com/Aliloraf/parallel/tree/main/packages/cli).

> **Not yet published.** This package is prepared for its first npm release (0.1.0) but is not on npm yet. Until then, install it from a local build: see [Install from a local build](https://github.com/Aliloraf/parallel#install-from-a-local-build-until-the-first-npm-release).

Once published:

```bash
npm install --save-dev @aliloraf/parallel-engine @aliloraf/parallel-sdk
```

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explore, replay } from '@aliloraf/parallel-engine';
import scenario from './last-item.ts';

test('finds and reproduces the interleaving that oversells the last item', async () => {
  const summary = await explore(scenario, { maxSchedules: 1_000 });
  assert.equal(summary.complete, true);
  assert.ok(summary.failures.length > 0);

  const result = await replay(scenario, summary.failures[0]!);
  assert.equal(result.status, 'replayed');
});
```

`@aliloraf/parallel-sdk` is a peer dependency: scenarios, the engine and the
CLI share one copy of it.

## API

| Export | Purpose |
|---|---|
| `explore(scenario, options?)` | Explores schedules depth-first. Options: `maxSchedules` (1000), `maxSteps` (100), `stopOnFailure`, `stepTimeoutMs` (10 000). Reports `complete`, `failures`, `outcomes`, `limitReached`, `haltReason`, `abandonedWork`, `nondeterminism`. |
| `replay(scenario, trace, options?)` | Replays a trace; `replayed` or `replay_diverged` with a machine-readable `divergence`. |
| `validateTrace(value)` | Structural validation of a schema-1 trace; throws `InvalidTraceError`. |
| `leavesAbandonedWork(trace)` | Whether a run left actor work the engine could not settle. |
| `InvalidTraceError`, `ExecutionError`, `DEFAULT_STEP_TIMEOUT_MS` | Errors and constants. |
| `Trace`, `ExploreResult`, `ReplayResult`, `ReplayDivergence`, ... | Types. |

`complete: true` means every modeled interleaving was explored within the
configured bounds — not that the application is correct outside that model.
Requires Node.js 22.18 or later. See the
[project documentation](https://github.com/Aliloraf/parallel#readme).

Licensed under Apache-2.0.
