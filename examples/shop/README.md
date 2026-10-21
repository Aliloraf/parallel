# Shop example: testing existing application code

A small order service with three concurrency bugs and their corrections. It
shows how to point Parallel at business logic you already have, instead of
rewriting that logic as a scenario.

## What this example does and does not model

Parallel interleaves the checkpoints you mark, and nothing else. This example
models **application-level interleaving**: the order in which requests reach a
shared store. It does not model real database isolation levels, transactions,
locks, replication lag, network timing, or retries. `MemoryStore` is a
deterministic stand-in with an atomicity contract written down in
[`src/store.ts`](src/store.ts); the payment gateway only records the calls it
received and never contacts anything.

A passing result therefore means that the orderings Parallel explored are
safe under that model, not that the production system is race-free.

## Layout

| Path | Contents |
|---|---|
| [`src/store.ts`](src/store.ts) | The in-memory record store and its atomicity contract. |
| [`src/inventory.ts`](src/inventory.ts) | Selling a unit of stock, unsafe and corrected. |
| [`src/payments.ts`](src/payments.ts) | Charging an order through a recording gateway, unsafe and corrected. |
| [`src/reservations.ts`](src/reservations.ts) | Holding an exclusive slot, unsafe and corrected. |
| [`scenarios/`](scenarios) | One Parallel scenario per bug, plus its corrected counterpart. |

Nothing under `src/` imports a Parallel package. The application layer only
accepts an optional `pause` callback, declared locally as `Pause` in
`src/store.ts`.

## How the instrumentation works

Every store method takes an optional `pause`:

```ts
async read<T>(key: string, pause?: Pause): Promise<Versioned<T> | undefined> {
  if (pause) await pause(`read ${key}`);
  // ...
}
```

Two things follow from this.

**Production is untouched.** Without a `pause` argument nothing is awaited that
would not have been awaited anyway, so there is no extra scheduling point and
no Parallel code on the request path.

**One statement is one step.** The pause marks the moment the statement is in
flight; everything after it runs without pausing again. So a single store call
is atomic with respect to other requests, and two store calls never are. That
is the whole reason the bugs below exist and the corrections work.

Business functions just pass `pause` through, which means instrumenting the
data-access layer once covers every call site:

```ts
export async function sellOneUnitUnsafe(store: MemoryStore, sku: string, pause?: Pause): Promise<void> {
  const record = await store.read<StockItem>(stockKey(sku), pause);
  if (record === undefined) throw new Error(`Unknown SKU ${sku}`);
  if (record.value.quantity <= 0) throw new OutOfStockError(sku);
  await store.write(stockKey(sku), { ...record.value, quantity: record.value.quantity - 1 }, pause);
}
```

A scenario then passes the SDK's `checkpoint` as that `pause`.

## The three bugs

| Scenario | Bug | Correction |
|---|---|---|
| `oversell` | Read the quantity, then write it back. Both customers read `1`, both write `0`, two units are sold. | One conditional statement: `updateIf` decrements only while the quantity is positive, modeling `UPDATE ... SET quantity = quantity - 1 WHERE quantity > 0`. |
| `duplicate-payment` | Check whether a charge is recorded, then insert one. Both retries find nothing and both reach the provider. | One insert that fails if the idempotency key exists, modeling `INSERT ... ON CONFLICT DO NOTHING` against a unique index. The uniqueness is what keeps the provider from being reached twice; a check-then-insert would not. See [what the payment correction guarantees](#what-the-payment-correction-guarantees). |
| `double-reservation` | Read the slot, then write the holder. Both requests see it free, the second overwrites the first, and both are told they hold it. | Write only while the slot is still at the version that was read (`compareAndWrite`), modeling `UPDATE ... WHERE version = ?`. The loser is told it conflicted. |

In each correction the two statements the bug needed become **one**, so there
is no window left for another request.

A single conditional statement only reports *whether* it changed anything, not
why it didn't — just as `UPDATE ... WHERE` reports a row count and no reason.
So `sellOneUnit` reads the record once the update declines, to tell "no such
SKU" apart from "out of stock" instead of reporting the wrong one. That read
is on the failure path only and cannot bring the race back: by then the
decrement has already happened or been refused.

Collapsing two statements into one also removes a scheduling point, which is
why `shop-oversell-fixed` explores 2 orderings where `shop-oversell` explores
6. That is the correction working, not the test being weakened: the operation
really is atomic now, so there is nothing left to interleave inside it.
`shop-double-reservation-fixed` makes the same point from the other side — it
keeps both scheduling points and all 6 orderings of the buggy version, and
still cannot produce two holders, because the write is conditional on the
version that was read.

## What the payment correction guarantees

The corrected `chargeOrder` is worth stating precisely, because four different
things are easy to confuse.

**It does guarantee: at most one request reaches the provider.** The claim is a
single insert against a unique key, so of any number of concurrent retries
exactly one proceeds to `authorize`. That is the concurrency bug, and it is
gone.

**It does not guarantee exactly-once payment.** If the provider rejects, the
claim stays behind with `receipt: null` and the key is spent, so no later call
retries it and the payment never happens. Releasing the claim on failure would
not fix this: a provider call that failed *after* charging would then be
retried and charge twice. Deciding which happened needs reconciliation with
the provider, which no amount of local locking supplies, so this example does
not pretend to.

**It does not report what it cannot know.** A request that loses the claim is
told `duplicate-request`: it did not charge, and it cannot tell whether the
winner succeeded, failed or is still running. Only once the winner has
recorded a receipt does a later retry get `already-charged`, with that
receipt. Returning `already-charged` for a claim that is merely held would be
a lie, and the `reported-receipts-were-issued` invariant fails any schedule in
which a request reports a receipt the provider never issued.

**Reusing one key for a different payment is an error**, not a silent success:
`chargeOrder` compares the order and amount on the claim it lost against its
own and throws `IdempotencyKeyReuseError`. The order and amount never change
after the insert, so that comparison is not itself racy.

Finally, `RecordingGateway` is not a payment provider. It records calls in
memory and nothing leaves the process, so "the provider was reached" means
"this code would have called out", not that any real behavior was reproduced.

## Expected rejections

A corrected request often fails for a perfectly good reason: the stock ran
out, the slot was taken, another request won the race. If such a rejection
escapes an actor, the engine reports the schedule as `actor_error` and **skips
its invariants**, hiding the very race the scenario is checking for.

The SDK's `attempt` records those rejections as state instead:

```ts
import { attempt } from '@aliloraf/parallel-sdk';

const result = await attempt(() => sell(state.store, SKU, checkpoint), (error) => error instanceof OutOfStockError);
state.attempts.push(result);
```

Each scenario names the errors its own code is allowed to produce, and the
`Attempt<T>` values collected in state are what the invariants read. `attempt`
never captures `SimulationCancelledError`, so cancellation and teardown keep
working, and it never captures a rejection the scenario did not list, so an
unexpected failure still surfaces as an actor error.

## Running it

```bash
# find the bug
npx --no parallel-sim test examples/shop/scenarios/oversell.ts --trace-out traces/oversell.json   # exit 1

# reproduce it as often as you like
npx --no parallel-sim replay traces/oversell.json examples/shop/scenarios/oversell.ts             # exit 1

# the corrected implementation
npx --no parallel-sim test examples/shop/scenarios/oversell-fixed.ts                              # exit 0
```

The passing exploration on the last line is the evidence that the race is
gone — within this model, since it covers every ordering of the instrumented
points.

Replaying the old trace is a weaker signal. In a real project you would edit
`src/inventory.ts` in place and keep the same scenario file, and the saved
trace would then report `decision_not_eligible` (exit 4), because the two
statements became one and the recorded decisions no longer exist. That says the
recorded execution is no longer available in the current scenario — which a
rename or an unrelated refactor also produces. It is not proof that the bug is
fixed. A trace remains a useful regression test the other way round: if a
replay that used to diverge starts reproducing the failure, the race is back.

This example keeps both implementations side by side under different scenario
names, so replaying `traces/oversell.json` against `oversell-fixed.ts` reports
a `scenario_mismatch` (also exit 4) before it gets that far.
`tests/shop-examples.test.ts` covers the in-place case by building the
corrected code under the buggy scenario's name.

## Results under the default bounds

| Scenario | Schedules | Complete | Failures | Invariant |
|---|---|---|---|---|
| `shop-oversell` | 6 | yes | 4 | `stock-matches-sales` |
| `shop-oversell-fixed` | 2 | yes | 0 | — |
| `shop-duplicate-payment` | 20 | yes | 18 | `charged-at-most-once` |
| `shop-duplicate-payment-fixed` | 12 | yes | 0 | — |
| `shop-double-reservation` | 6 | yes | 4 | `at-most-one-holder` |
| `shop-double-reservation-fixed` | 6 | yes | 0 | — |

Every scenario explores every ordering within `explore`'s defaults, so each
result is a complete answer for the model. `tests/shop-examples.test.ts`
asserts these numbers, that every failure replays, and that the application
code behaves correctly with no instrumentation at all.

[Testing application code](../../docs/07-testing-application-code.md) uses this
example as its reference implementation and explains how to apply the same
approach to your own code.
