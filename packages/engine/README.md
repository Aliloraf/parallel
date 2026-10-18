# @aliloraf/parallel-engine

The [Parallel](https://github.com/Aliloraf/parallel) engine. It explores the interleavings of a scenario's checkpoints, checks its invariants, records failing schedules as traces and replays them. Use it to run scenarios from your own code or test runner (`node:test`, Vitest, Jest); for the command line, use [`@aliloraf/parallel-cli`](https://github.com/Aliloraf/parallel/tree/main/packages/cli).

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

`last-item.ts` is the scenario from the [`@aliloraf/parallel-sdk` README](https://github.com/Aliloraf/parallel/tree/main/packages/sdk). The SDK is a peer dependency, so scenarios, the engine and the CLI share one copy of it.

## API

| Export | Description |
|---|---|
| `explore(scenario, options?)` | Explores schedules depth-first. Options: `maxSchedules` (default 1000), `maxSteps` (100), `stepTimeoutMs` (10000), `stopOnFailure` (`false`). The result has `complete`, `failures`, `outcomes`, `limitReached`, `haltReason`, `abandonedWork` and `nondeterminism`. |
| `replay(scenario, trace, options?)` | Replays a trace. Returns `replayed`, or `replay_diverged` with a `divergence` describing why. |
| `validateTrace(value)` | Checks the structure of a trace; throws `InvalidTraceError`. |
| `leavesAbandonedWork(trace)` | Whether the run left actor work that the engine could not settle. |
| `InvalidTraceError`, `ExecutionError`, `DEFAULT_STEP_TIMEOUT_MS` | Errors and constants. |
| `Trace`, `ExploreResult`, `ReplayResult`, `ReplayDivergence`, … | Types. |

`complete: true` means every interleaving of the checkpoints was explored within the bounds, not that the code is correct outside that model. Requires Node.js 22.18 or later. See the [documentation](https://github.com/Aliloraf/parallel#documentation) for the exact semantics.

Apache License 2.0.
