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
| `Scenario`, `Actor`, `Invariant`, `StepContext` | Types. `StepContext` gives each actor `state`, `checkpoint(name)` and `signal`. |

Code between two checkpoints runs as one step; Parallel only interleaves the checkpoints. Requires Node.js 22.18 or later. [Writing scenarios](https://github.com/Aliloraf/parallel/blob/main/docs/06-writing-scenarios.md) explains how to choose checkpoints and test existing code.

Apache License 2.0.
