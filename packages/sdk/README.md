# @aliloraf/parallel-sdk

Scenario API for **Parallel**, a deterministic concurrency testing engine for
TypeScript and Node.js. A scenario declares fresh initial state, concurrent
actors that pause at named checkpoints, and invariants that must hold however
the actors interleave.

> **Not yet published.** This package is prepared for its first npm release (0.1.0) but is not on npm yet. Until then, install it from a local build: see [Install from a local build](https://github.com/Aliloraf/parallel#install-from-a-local-build-until-the-first-npm-release).

Once published:

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

Run it with `npx parallel-sim test last-item.ts`.

## API

| Export | Purpose |
|---|---|
| `defineScenario(scenario)` | Validates and returns a scenario (unique actor IDs, at least two actors, at least one invariant). |
| `SimulationCancelledError` | The error a paused actor receives when its run is closed; also the reason of an aborted `context.signal`. |
| `Scenario`, `Actor`, `Invariant`, `StepContext` | Types. `StepContext` gives each actor `state`, `checkpoint(name)` and `signal`. |

Only code between checkpoints runs as one indivisible step; Parallel does not
interleave anything it does not control. Requires Node.js 22.18 or later.
See the [project documentation](https://github.com/Aliloraf/parallel#readme).

Licensed under Apache-2.0.
