# @aliloraf/parallel-sdk

The scenario API for [Parallel](https://github.com/Aliloraf/parallel), which tests asynchronous TypeScript code for race conditions by running it under every ordering of the checkpoints you mark. A scenario has fresh initial state, two or more actors that pause at named checkpoints, and invariants that must hold however the actors interleave.

```bash
npm install --save-dev @aliloraf/parallel-sdk @aliloraf/parallel-cli
```

```ts
import { defineScenario } from '@aliloraf/parallel-sdk';
import type { StepContext } from '@aliloraf/parallel-sdk';

type State = { stock: number; sold: number };

const purchase = async ({ state, checkpoint }: StepContext<State>) => {
  await checkpoint('read-stock');
  const available = state.stock;
  await checkpoint('commit');
  if (available > 0) {
    state.stock = available - 1;
    state.sold++;
  }
};

export default defineScenario<State>({
  name: 'last-item',
  createState: () => ({ stock: 1, sold: 0 }),
  actors: [{ id: 'alice', run: purchase }, { id: 'bob', run: purchase }],
  invariants: [{ name: 'no-overselling', check: ({ sold }) => sold <= 1 }],
});
```

Run it with `npx --no parallel-sim test last-item.ts` once `@aliloraf/parallel-cli` is installed, or programmatically with `@aliloraf/parallel-engine`.

## API

| Export | Description |
|---|---|
| `defineScenario(scenario)` | Checks a scenario (a name, at least two actors with unique ids, at least one invariant with a unique name) and returns it. |
| `SimulationCancelledError` | Rejects pending checkpoints when a run is closed; also the reason of the aborted `context.signal`. |
| `attempt(operation, isExpected)` | Runs application code that may reject, capturing only the errors `isExpected` accepts. [See below](#expected-application-errors). |
| `Scenario`, `Actor`, `Invariant`, `StepContext`, `Attempt` | Types. `StepContext` gives each actor `state`, `checkpoint(name)` and `signal`. |

Code between two checkpoints runs as one step; Parallel only interleaves the checkpoints. Requires Node.js 22.18 or later.

## Expected application errors

> `attempt` and `Attempt<T>` are not in the published 0.1.0 package. Until the next release they need a [local build](https://github.com/Aliloraf/parallel#from-a-local-build).

Real code rejects requests for correct reasons: sold out, already taken, lost an optimistic-concurrency race. An error that escapes an actor makes the whole schedule an `actor_error`, and the engine then **evaluates no invariants for it** — so the race the scenario exists to find goes unreported.

`attempt` turns a rejection the scenario names into data the invariants can read:

```ts
// tickets.ts — a complete scenario; run it with `npx --no parallel-sim test tickets.ts`
import { attempt, defineScenario } from '@aliloraf/parallel-sdk';
import type { Attempt } from '@aliloraf/parallel-sdk';

class SoldOutError extends Error {}

type Tickets = { remaining: number };
type State = { tickets: Tickets; sales: Attempt<string>[] };

// Stands in for your own module: it takes the pause callback as an optional
// parameter, and rejects when there is nothing left to sell.
const buyTicket = async (tickets: Tickets, pause?: (label: string) => Promise<void>): Promise<string> => {
  if (pause) await pause('read-remaining');
  const remaining = tickets.remaining;
  if (pause) await pause('commit');
  if (remaining <= 0) throw new SoldOutError('sold out');
  tickets.remaining = remaining - 1;
  return `ticket-${remaining}`;
};

export default defineScenario<State>({
  name: 'ticket-sales',
  createState: () => ({ tickets: { remaining: 1 }, sales: [] }),
  actors: ['buyer-a', 'buyer-b'].map((id) => ({
    id,
    async run({ state, checkpoint }) {
      // Being sold out is a correct outcome; anything else is a defect.
      state.sales.push(await attempt(() => buyTicket(state.tickets, checkpoint), (error) => error instanceof SoldOutError));
    },
  })),
  invariants: [{
    // The invariant reads what the requests were actually told.
    name: 'no-more-tickets-than-seats',
    check: ({ sales }) => sales.filter(({ ok }) => ok).length <= 1,
    describeFailure: ({ sales }) => `sold ${sales.filter(({ ok }) => ok).length} tickets for 1 seat`,
  }],
});
```

`Attempt<T>` is `{ ok: true, value: T } | { ok: false, error: Error }`.

The predicate is required; there is no catch-all mode. Three rejections are never captured, so that a defect can never be mistaken for an expected outcome:

- **`SimulationCancelledError`, always**, without consulting the predicate. The engine's cancellation and teardown contract depends on it reaching the actor. A catch-all would leave a retry loop calling `checkpoint()` after the run closed, which the engine reports as `ignored-cancellation` and abandoned work.
- **Anything the predicate rejects**, re-thrown as the same instance, so unexpected failures still surface as actor errors.
- **A thrown value that is not an `Error`**, re-thrown exactly as thrown rather than wrapped.

If the predicate itself throws, that failure propagates instead of being reported as an expected result.

[Testing application code](https://github.com/Aliloraf/parallel/blob/main/docs/07-testing-application-code.md) covers this in context; [writing scenarios](https://github.com/Aliloraf/parallel/blob/main/docs/06-writing-scenarios.md) explains how to choose checkpoints.

Apache License 2.0.
