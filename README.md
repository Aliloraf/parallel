# Parallel

**A local-first, deterministic concurrency testing engine for instrumented TypeScript programs.**

Parallel explores possible orderings of explicitly controlled asynchronous operations and checks user-defined invariants. Its first example demonstrates how two customers can both purchase the last item in stock.

> **Status: early, pre-1.0 (0.1.0).** The engine has a working scheduler, schedule exploration, invariant checking, traces, deterministic replay, stall detection, nondeterminism detection, and an installable CLI. The packages are not yet published to npm. Remaining SRS requirements are still planned.

## Packages

These three packages are **prepared for publication but not yet published to npm**. Version 0.1.0 is unreleased (see [CHANGELOG.md](CHANGELOG.md)). Until the first release, install them from a local build, as described below.

| Package | Contents |
|---|---|
| [`@aliloraf/parallel-sdk`](packages/sdk) | Scenario API: `defineScenario`, `SimulationCancelledError`, scenario types |
| [`@aliloraf/parallel-engine`](packages/engine) | `explore`, `replay`, `validateTrace` and result/trace types, for programmatic use |
| [`@aliloraf/parallel-cli`](packages/cli) | The `parallel-sim` command |

All three have the same version and no runtime dependencies besides each other. The SDK is a peer dependency, so scenarios, the engine and the CLI share one copy of it.

## Requirements

- Node.js **22.18.0 or later**, which strips TypeScript types natively, so scenarios run without a build step
- npm

## Use Parallel in your project

### Install from a local build (until the first npm release)

Build and pack the three packages from a checkout of this repository, then install the tarballs into your project. Install all three, even if you only use the CLI: the CLI depends on the engine, and npm cannot fetch an unpublished engine from the registry. `npm pack` does not create its destination directory, so create it first.

macOS / Linux (bash or zsh):

```bash
git clone https://github.com/Aliloraf/parallel.git
cd parallel
npm ci
npm run build
mkdir -p "$HOME/parallel-packages"
npm pack --workspaces --pack-destination "$HOME/parallel-packages"

cd /path/to/your-project
npm install --save-dev \
  "$HOME/parallel-packages/aliloraf-parallel-sdk-0.1.0.tgz" \
  "$HOME/parallel-packages/aliloraf-parallel-engine-0.1.0.tgz" \
  "$HOME/parallel-packages/aliloraf-parallel-cli-0.1.0.tgz"
```

Windows (PowerShell):

```powershell
git clone https://github.com/Aliloraf/parallel.git
cd parallel
npm ci
npm run build
New-Item -ItemType Directory -Force "$HOME\parallel-packages" | Out-Null
npm pack --workspaces --pack-destination "$HOME\parallel-packages"

cd C:\path\to\your-project
npm install --save-dev `
  "$HOME\parallel-packages\aliloraf-parallel-sdk-0.1.0.tgz" `
  "$HOME\parallel-packages\aliloraf-parallel-engine-0.1.0.tgz" `
  "$HOME\parallel-packages\aliloraf-parallel-cli-0.1.0.tgz"
```

Your project must use Node.js 22.18.0 or later. npm records the tarball paths in your `package.json` as `file:` dependencies; re-run `npm install` after rebuilding to pick up changes.

### Install from npm (after the first release)

Once 0.1.0 is published, this will be:

```bash
npm install --save-dev @aliloraf/parallel-cli @aliloraf/parallel-sdk
# add @aliloraf/parallel-engine for programmatic use
```

### Write a scenario

A scenario declares fresh initial state, actors that pause at named checkpoints, and invariants that must hold in every interleaving:

```ts
// scenarios/last-item.ts
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
  invariants: [{
    name: 'no-overselling',
    check: ({ sold }) => sold <= 1,
    describeFailure: ({ sold }) => `sold ${sold} items, but only 1 was in stock`,
  }],
});
```

### Run it, export a failure trace and replay it

```bash
npx parallel-sim test scenarios/last-item.ts
npx parallel-sim test scenarios/last-item.ts --trace-out traces/last-item.json
npx parallel-sim replay traces/last-item.json scenarios/last-item.ts
npx parallel-sim test scenarios/last-item.ts --json      # machine-readable summary
```

`test` exits with status 1 because it finds the oversell. Replaying a known failure also exits with 1, which makes a saved trace usable as a CI regression check. Exit status 0 means exploration completed without failures. Status 2 means a usage error, an invalid scenario or trace, or an engine failure. Run `npx parallel-sim --help` for every option.

> `npx` uses the locally installed `parallel-sim`. In a project where it is **not** installed, `npx parallel-sim` would try to download an unrelated package of that name from the npm registry. Install the CLI first, and use `npx --no parallel-sim` in CI to rule that out.

### Use the engine programmatically

With the engine installed (it is one of the three local tarballs; after the first release, `npm install --save-dev @aliloraf/parallel-engine`), run scenarios from any test runner:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explore, replay } from '@aliloraf/parallel-engine';
import scenario from './scenarios/last-item.ts';

test('finds and reproduces the oversell', async () => {
  const summary = await explore(scenario, { maxSchedules: 1_000 });
  assert.equal(summary.complete, true);
  assert.ok(summary.failures.length > 0);
  assert.equal((await replay(scenario, summary.failures[0]!)).status, 'replayed');
});
```

### TypeScript requirements

Scenarios run on Node.js's built-in type stripping. That requires:

- erasable syntax only: no `enum`, `namespace` or constructor parameter properties;
- `import type` for type-only imports;
- explicit `.ts` extensions on relative imports.

Suggested `tsconfig.json` settings: `"module": "nodenext"`, `"verbatimModuleSyntax": true`, `"erasableSyntaxOnly": true`, `"allowImportingTsExtensions": true` and `"noEmit": true`. The CLI reports which rule a scenario broke. For code that can't meet them, register your own TypeScript loader: `NODE_OPTIONS=--import=tsx npx parallel-sim test ...`. `.js` and `.mjs` scenarios have no such constraints. The packages are ES modules and can also be `require()`d from CommonJS. See [docs/05-packaging.md](docs/05-packaging.md).

## Develop Parallel

```bash
npm ci
npm test                  # builds, then runs the unit and CLI tests
npm run typecheck         # builds, then type-checks tests and examples
npm run test:integration  # packs the packages and tests them from an independent project
npm run demo              # exits 1: finds the inventory bug
npm run demo:fixed        # exits 0
```

`npm run cli -- <args>` runs the repository's `parallel-sim` (built first):

```bash
npm run cli -- test inventory-buggy --trace-out traces/failure.json
npm run cli -- replay traces/failure.json
npm run cli -- test examples/counter/src/scenario.ts --json
```

The built-in demos `inventory-buggy` and `inventory-fixed` ship with the CLI. Traces are local files that may contain application-specific data; `traces/*.json` is ignored by Git.

## How it works

1. A scenario declares a `createState` factory, actor functions and invariants.
2. Actors pause at `await checkpoint('name')` before taking the next controlled step.
3. Parallel selects an actor to resume and records the decision.
4. It restarts from fresh state to explore alternate scheduling decisions.
5. It evaluates invariants after a run and can replay a failure by following saved decisions.

**Important:** The engine controls *only* explicitly declared checkpoints. Work between checkpoints is effectively atomic as far as the scheduler is concerned. Unmanaged `await`, timers, network calls, randomness, or external I/O can invalidate repeatability. Importing a scenario **executes its code**: run only trusted scenarios. Parallel does **not** sandbox code or prove an arbitrary app is bug-free.

The six expected interleavings of two actors with two checkpoints each are covered by automated tests.

## Stalls, timeouts and cancellation

If an actor doesn't reach its next checkpoint or finish within `stepTimeoutMs`
(default 10 000 ms, CLI `--step-timeout MS`), Parallel reports the schedule as
`stalled`, names the actor and its last checkpoint, and halts exploration. A
stalled exploration is never reported as complete or passing.

```bash
npx parallel-sim test scenarios/my-scenario.ts --step-timeout 2000
```

Stall **detection is not cancellation**. When a run closes, Parallel aborts
`context.signal` and rejects pending checkpoints with `SimulationCancelledError`.
Actors that pass the signal to cancellable APIs (for example
`fetch(url, { signal })`) can stop cleanly. Parallel cannot force arbitrary
promises, I/O or synchronous code to stop. Work that does not cooperate is
reported as abandoned (`abandonedWork: true`). In that case the CLI terminates
the process after writing and flushing its report. Synchronous infinite loops
can't be detected at all. The timeout uses wall-clock time and is not part of
deterministic scheduling. See [docs/03-execution-lifecycle.md](docs/03-execution-lifecycle.md)
for the actor states, teardown rules and trace fields.

## Nondeterminism and replay

Exploration re-runs the scenario from scratch for every schedule, so it relies
on the scenario being deterministic at its checkpoints. When re-running a
schedule prefix offers different eligible actors or checkpoints than the run
that recorded it, Parallel halts with `haltReason: 'nondeterministic'`. It
reports the expected and observed choices, keeps every outcome and failure
found so far, and exits with status 1. This detection only covers differences
visible at checkpoints. It does not prove a scenario deterministic.

`Exploration complete: true` means every modeled interleaving was explored
within the configured bounds. It does not mean the application is correct
outside that model.

`replay` validates the trace before running it. Invalid JSON and invalid traces
exit with status 2, and the message names the bad field. A replay that can't
reproduce the trace prints a machine-readable `divergence`. Its `kind` is one
of `decision_not_eligible`, `ended_early`, `continued`, `result_mismatch`,
`scenario_mismatch` or `unsupported_schema`. Traces that hit the step limit
replay correctly. See
[docs/04-nondeterminism-and-replay.md](docs/04-nondeterminism-and-replay.md).

## Repository layout

```text
packages/sdk/           @aliloraf/parallel-sdk: scenario definitions and the cooperative checkpoint API
packages/engine/        @aliloraf/parallel-engine: exploration, trace generation, validation and replay
packages/cli/           @aliloraf/parallel-cli: the parallel-sim command and its built-in inventory demos
examples/counter/       A lost-update scenario written as an external project would write it
tests/                  Unit and CLI tests; tests/integration/ tests the packed npm tarballs
tests/fixtures/         Scenarios and fixed traces from earlier versions, for compatibility tests
docs/01-parallel.md     Project vision
docs/02-requirements.md Draft SRS, target requirements for v0.1
docs/03-execution-lifecycle.md       Actor states, stall detection, cancellation limits
docs/04-nondeterminism-and-replay.md Nondeterminism detection, completeness, replay divergence
docs/05-packaging.md                 Package architecture, external usage, publishing checklist
```

Each package is built with `tsc -b` into its `dist/` directory: JavaScript, type declarations and source maps. Only `dist/`, `README.md`, `LICENSE` and `package.json` are published.

## Next steps

- First npm release of the three packages (see the publishing checklist in [docs/05-packaging.md](docs/05-packaging.md)).
- CLI argument parsing and a distinct exit code for replay divergence and nondeterminism.
- Trace format v2: record choice points and run configuration so replay can detect changed choices, with a migration path from v1.
- Run actors in worker threads to enable forced cancellation and detection of synchronous hangs.
- Investigate schedule-reduction techniques after correctness is demonstrated.

## License and naming

Parallel is licensed under the [Apache License 2.0](LICENSE).

`Parallel` is a working project name. The npm packages are published under the `@aliloraf` scope, and the command is `parallel-sim`, because the unscoped name `parallel` and the `parallel` command are already used by other software (including GNU Parallel). Check trademarks before using the name commercially.
