# Testing application code

This guide covers using Parallel on business logic you already have, rather than
on a scenario written from scratch. [`examples/shop/`](../examples/shop) is the
reference implementation: a small order service with three concurrency bugs,
their corrections, and [tests](../tests/shop-examples.test.ts) that pin every
result quoted here.

[Writing scenarios](06-writing-scenarios.md) covers the scenario API itself —
checkpoints, state, invariants. This guide covers the integration around it.

The TypeScript blocks below marked *excerpt* are quoted from
[`examples/shop/`](../examples/shop); read the files for the whole picture. The
shell commands and the [CI example](#in-a-development-or-ci-workflow) are
complete and are executed by the test suite.

> **Availability.** `attempt()` and `Attempt<T>` were introduced in 0.2.0 and
> need that version or later; everything else here also works with 0.1.0. On
> an earlier version, either upgrade or write the same try/catch by hand, and
> make sure it re-throws `SimulationCancelledError` — see
> [expected errors](#6-capture-expected-errors).

## The shape of the integration

Parallel needs three things from your application: somewhere to yield, state it
can recreate, and properties to check. Nothing else about your code has to
change.

```text
your module          scenario file                  Parallel
-----------          -------------                  --------
sellOneUnit(store, sku, pause?)  <--- checkpoint ---  actor "customer-a"
                                 <--- checkpoint ---  actor "customer-b"
createState() -> fresh store     --------------------> fresh per schedule
                                 invariants ---------> checked after each run
```

The application layer stays free of Parallel: nothing under
[`examples/shop/src/`](../examples/shop/src) imports a Parallel package, and a
test asserts it.

## 1. Find a concurrency-sensitive function

Look for a function that reads shared state, decides something, and then writes
based on that decision — check-then-act, read-modify-write, "insert if it isn't
there". Two requests running it at once is the interesting case.

`sellOneUnitUnsafe` in [`src/inventory.ts`](../examples/shop/src/inventory.ts)
reads a quantity, checks it, and writes the decrement.

## 2. Find the points where interleaving matters

Another request can interleave wherever yours waits — in practice, at each call
that leaves the process. One database statement is one such point, and whatever
happens between two of them cannot be interrupted by another request.

So instrument the boundary, not the business logic. In the shop example every
`MemoryStore` method takes the callback, and the business functions simply pass
it along, which means one instrumented data-access layer covers every call site.

## 3. Add optional checkpoint instrumentation

Accept an optional callback and guard it, so that an uninstrumented call awaits
nothing it would not have awaited anyway:

```ts
// src/store.ts — excerpt, and no Parallel import
export type Pause = (label: string) => Promise<void>;

async read<T>(key: string, pause?: Pause): Promise<Versioned<T> | undefined> {
  if (pause) await pause(`read ${key}`);
  return /* ... */;
}
```

Declare `Pause` locally. It is structurally identical to the SDK's
`checkpoint`, so a scenario can pass `checkpoint` straight in, and your
production build keeps no dependency on Parallel. Prefer `pause?: Pause` over a
no-op default: a default still introduces an `await`.

Label checkpoints after the operation (`read stock:sku-1`). Labels appear in
failure output and traces.

## 4. Define actors for the concurrent requests

One actor per competing request. Each one calls your real function:

```ts
// scenarios/oversell.ts — excerpt
actors: ['customer-a', 'customer-b'].map((id) => ({
  id,
  async run({ state, checkpoint }) {
    const result = await attempt(() => sellOneUnit(state.store, SKU, checkpoint), (error) => error instanceof OutOfStockError);
    state.attempts.push(result);
  },
})),
```

## 5. Build fresh deterministic state

`createState()` runs again for every schedule, and it is the only reset hook
Parallel has. Construct the store, fakes and fixtures inside it:

```ts
// scenarios/oversell.ts — excerpt
createState: () => ({
  store: new MemoryStore({ [stockKey(SKU)]: { sku: SKU, quantity: 1 } }),
  attempts: [],
}),
```

Anything reached through a module-level singleton — a client, a pool, a cache —
is **not** reset, and will accumulate across schedules. Exploration also
re-runs the actor bodies once per schedule: six schedules means six executions.
That is why the dependencies must be in-process fakes, and why real external
side effects cannot be driven this way (see
[limitations](../README.md#limitations)).

Keep fakes deterministic. A counter for ids, not `randomUUID()`; no
`Date.now()`. Values that change between runs break replay, and can make
exploration report nondeterminism.

## 6. Capture expected errors

Correct code rejects requests for good reasons: out of stock, slot taken, lost
an optimistic-concurrency race. If such a rejection escapes an actor, the
schedule's outcome becomes `actor_error` and **the engine evaluates no
invariants for it**, hiding the race the scenario exists to find.

`attempt()` turns a rejection your scenario names into data the invariants can
read:

```ts
// scenarios/oversell.ts — excerpt
import { attempt } from '@aliloraf/parallel-sdk';
import type { Attempt } from '@aliloraf/parallel-sdk';

const result: Attempt<void> = await attempt(
  () => sellOneUnit(state.store, SKU, checkpoint),
  (error) => error instanceof OutOfStockError,
);
```

List only the errors you mean. Anything else is re-thrown and still surfaces as
an actor error, and `SimulationCancelledError` is always re-thrown — a
catch-all would leave actors retrying checkpoints after the run closed, which
the engine then reports as `ignored-cancellation` and abandoned work. See the
[SDK README](../packages/sdk/README.md#expected-application-errors).

## 7. Write invariants worth checking

An invariant should state a property of the system, not restate the
implementation. The three in the shop example:

| Invariant | Property |
|---|---|
| `stock-matches-sales` | Units sold and units remaining add up to the starting stock. |
| `charged-at-most-once` | The provider was called at most once, and exactly as many requests reported a charge. |
| `at-most-one-holder` | Every request told it holds the slot really does hold it. |

Invariants run once per schedule, after all actors finish, on the final state.
To assert something about the sequence of events, record the events in state and
check the record. They are synchronous, so expose a synchronous view of your
fake for them to read (`MemoryStore.peek`) rather than the async one your
application uses.

## 8. Explore the schedules

With the CLI installed in your project:

```bash
npx --no parallel-sim test scenarios/oversell.ts
```

From a checkout of this repository, where the CLI is built rather than
installed:

```bash
npm ci && npm run build
node packages/cli/dist/cli.js test examples/shop/scenarios/oversell.ts
```

The rest of this guide uses the installed form. In a checkout, substitute
`node packages/cli/dist/cli.js` for `npx --no parallel-sim` and prefix the
scenario paths with `examples/shop/`.

Keep each scenario small. Two actors over a function with six instrumented
awaits is 924 schedules; seven exceeds the default `--max-schedules 1000`,
which is reported as incomplete (exit 3) rather than passed.

## 9. Read the failure

```text
Scenario: shop-oversell
Schedules explored: 6
Failures: 4 (invariant_failed: 4)
Exploration complete: true

First failure (invariant_failed):
  1. customer-b: read stock:sku-1
  2. customer-a: read stock:sku-1
  3. customer-a: write stock:sku-1
  4. customer-b: write stock:sku-1
  VIOLATION stock-matches-sales: 2 of 1 unit(s) sold, but 0 left in stock

Result: failed
```

The numbered list is the schedule: both customers read before either wrote.
`Exploration complete: true` says every ordering within the bounds was tried —
check it before trusting a pass.

## 10. Save and replay the trace

```bash
npx --no parallel-sim test scenarios/oversell.ts --trace-out traces/oversell.json
npx --no parallel-sim replay traces/oversell.json scenarios/oversell.ts
```

Replay forces the recorded decisions and compares the outcome, so the failure
is reproducible as often as you need while you debug. Exit 1 means it still
fails. `--trace-out` creates the directory if it does not exist, so
`traces/` need not be there already.

## 11. Correct the application code

The corrections in the shop example all replace two statements with one, so
there is no window left for another request:

| Bug | Correction |
|---|---|
| Read the quantity, then write it back | One conditional update: `UPDATE ... SET quantity = quantity - 1 WHERE quantity > 0` |
| Check for a charge, then insert one | One insert against a unique idempotency key: `INSERT ... ON CONFLICT DO NOTHING` |
| Read the slot, then write the holder | One conditional write on the version read: `UPDATE ... WHERE version = ?` |

## 12. Validate the correction

Run a fresh exploration of the corrected code:

```bash
npx --no parallel-sim test scenarios/oversell-fixed.ts   # exit 0
```

**A complete exploration with no failures is the evidence**, within the model
you wrote. Replaying the old trace is useful but proves less: a changed scenario
usually no longer offers the recorded decisions, so replay reports
`decision_not_eligible` and exits 4. That says the recorded execution no longer
exists in the current scenario — which is also what a rename or an unrelated
refactor produces. It is not evidence that the bug is gone.

A trace stays a useful regression test while the scenario still produces it: if
a replay that used to diverge starts reproducing the failure again, the race is
back.

## In a development or CI workflow

From a test runner, through the engine, so a regression fails the build:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explore } from '@aliloraf/parallel-engine';
import scenario from './scenarios/oversell-fixed.ts';

test('concurrent purchases never oversell', async () => {
  const summary = await explore(scenario);
  assert.equal(summary.complete, true);   // the pass covers every ordering in the bounds
  assert.equal(summary.haltReason, null);
  assert.deepEqual(summary.failures, []);
});
```

Asserting `complete` and `haltReason` matters: without them a run that stopped
at a bound, stalled or detected nondeterminism also has no failures to report.
[`tests/shop-examples.test.ts`](../tests/shop-examples.test.ts) does this for
all six scenarios.

From the command line, the CLI's exit codes separate the cases — 0 passed,
1 failures, 3 incomplete, 4 nondeterminism or replay divergence — so
`parallel-sim test` can gate a build directly. The
[CLI README](../packages/cli/README.md) has the full table.

## The payment example, precisely

The corrected payment workflow in
[`src/payments.ts`](../examples/shop/src/payments.ts) is worth reading closely,
because five things are easy to conflate and only the first is guaranteed.

| | Status |
|---|---|
| **Preventing duplicate concurrent provider calls** | **Guaranteed.** One unique insert decides which of any number of concurrent retries proceeds, so the provider is reached at most once. |
| **Claiming the idempotency key** | What the insert actually does. A claim means "this request owns the payment", not "the payment happened". |
| **A payment in progress** | Reported as `duplicate-request`: a request that lost the claim did not call the provider and cannot tell whether the winner succeeded, failed or is still running. |
| **A confirmed completed payment** | Reported as `already-charged`, and only once a receipt has been recorded on the claim. A claim with no receipt is never reported as a completed charge. |
| **Recovering after an ambiguous provider failure** | **Not attempted.** If the provider rejects, the claim remains with no receipt and the key is spent, so the payment never happens. |

That last row is a deliberate non-goal, not an oversight. Releasing the claim on
failure would be worse: a provider call that failed *after* charging would then
be retried and charge twice. Deciding which of those happened requires
reconciliation with the provider, which no amount of local locking supplies.

So the example demonstrates **eliminating a concurrency bug**, not exactly-once
payment processing. `RecordingGateway` is a deterministic in-memory model that
records calls; nothing leaves the process, and no payment-provider behavior is
reproduced.

## What this does and does not establish

A complete exploration with passing invariants means: under the model you
wrote — your instrumented points, your fakes, your invariants — no ordering of
those points violated those properties. It does not cover code between
checkpoints, uninstrumented awaits, real database isolation, or network and
timer behavior. The [limitations](../README.md#limitations) section lists what
Parallel does not control, and
[nondeterminism and replay](04-nondeterminism-and-replay.md) defines exactly
what `complete` means.
