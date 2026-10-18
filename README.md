# Parallel

Parallel finds race conditions in asynchronous TypeScript code. You mark the points where concurrent operations can interleave, and Parallel runs your scenario once for each ordering of those points (up to limits you can set), checks your invariants after each run, and saves any failing ordering as a trace you can replay deterministically.

Status: early development (0.x). Expect breaking changes between minor versions; the [changelog](CHANGELOG.md) lists every release.

## Why

Concurrency bugs depend on ordering. Two requests that each check stock and then buy the last item are fine one after the other, but both succeed if both checks run before either purchase. A normal test runs one ordering and passes. Running it a thousand times may or may not hit the bad one, and if it does, you can't easily reproduce it.

Parallel enumerates the orderings instead of hoping for them, and every failure it reports comes with the exact schedule that caused it.

## How it works

A scenario has three parts: a function that creates fresh state, two or more actors (async functions), and invariants over the final state. Inside an actor, `await checkpoint('name')` pauses until the scheduler lets that actor continue. Parallel explores the interleavings of checkpoints depth-first, restarting from fresh state for each one, and records the scheduling decisions of every run.

Only checkpoints are controlled. Code between two checkpoints runs as a single step, and Parallel does not see timers, I/O or promises you haven't marked. A passing result means no invariant failed in the orderings Parallel could explore, not that the code is race-free.

## Example

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

With the CLI installed in your project (see [Installation](#installation)):

```console
$ npx --no parallel-sim test scenarios/last-item.ts
Scenario: last-item
Schedules explored: 6
Failures: 4 (invariant_failed: 4)
Exploration complete: true

First failure (invariant_failed):
  1. bob: read-stock
  2. alice: read-stock
  3. alice: commit
  4. bob: commit
  VIOLATION no-overselling: sold 2 items, but only 1 was in stock

Result: failed
```

Save the failure and replay it later, for example in CI after fixing the bug:

```bash
npx --no parallel-sim test scenarios/last-item.ts --trace-out traces/last-item.json
npx --no parallel-sim replay traces/last-item.json scenarios/last-item.ts
```

## Installation

Parallel requires Node.js 22.18 or later, which runs TypeScript scenarios directly through its built-in type stripping.

```bash
npm install --save-dev @aliloraf/parallel-cli @aliloraf/parallel-sdk
```

Add `@aliloraf/parallel-engine` to run scenarios from your own code or test runner.

### From a local build

To use a version that isn't on npm, build the packages from this repository and install the tarballs into your project. Install all three: the CLI depends on the exact engine version, which npm otherwise tries to fetch from the registry. `npm pack` won't create the destination directory, so create it first.

On macOS or Linux:

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

On Windows, in PowerShell:

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

npm records the tarballs as `file:` dependencies; run `npm install` again after rebuilding.

## Packages

| Package | What it contains |
|---|---|
| [`@aliloraf/parallel-sdk`](packages/sdk) | `defineScenario`, `SimulationCancelledError` and the scenario types. Scenarios import only this. |
| [`@aliloraf/parallel-engine`](packages/engine) | `explore`, `replay` and `validateTrace`, for running scenarios from your own code or test runner. |
| [`@aliloraf/parallel-cli`](packages/cli) | The `parallel-sim` command. |

The engine can run scenarios from any test runner:

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

## The `parallel-sim` command

```text
parallel-sim test <scenario> [--json] [--max-schedules N] [--max-steps N] [--step-timeout MS] [--trace-out PATH]
parallel-sim replay <trace> [scenario] [--json] [--step-timeout MS]
parallel-sim --help | --version
```

A scenario is a `.ts`, `.mts`, `.js` or `.mjs` file whose default export (or `scenario` export) is a scenario, or one of the built-in demos `inventory-buggy` and `inventory-fixed`. `--trace-out` writes the first failing schedule, and says so when there was nothing to write. `replay` needs the scenario file again unless the trace is from a built-in demo. Options can go anywhere after the command; unknown, repeated or malformed options are rejected before any scenario code runs.

| Exit status | Meaning |
|---|---|
| 0 | Exploration completed without failures, or a replayed trace passed. |
| 1 | Failures found (invariant violations, actor errors, stalls), or a replayed trace still fails. |
| 2 | Invalid usage or input, such as an unknown option, a missing scenario or trace, or a trace that couldn't be written. |
| 3 | Exploration stopped at `--max-schedules` or `--max-steps`, or because of abandoned work, without finding failures. |
| 4 | The scenario behaved nondeterministically, or a replay diverged from its trace. |
| 5 | Runtime error: an uncaught error from scenario code outside a controlled step, or an engine failure. |

So in CI, replaying a saved failure exits with 1 while the bug is still there and with 4 once the code no longer produces that trace. With `--json`, both commands print a single JSON report on stdout and send any output from scenario code to stderr; the [CLI documentation](packages/cli/README.md#json-output) describes the format.

The examples use `npx --no`, which runs the CLI installed in the current project and fails instead of installing anything when it isn't there. Without `--no`, npx would offer to install a registry package named `parallel-sim`, which is not part of Parallel. With `--no`, options that come before a subcommand need a `--`: `npx --no parallel-sim -- --help`.

TypeScript scenarios have to follow Node.js's type-stripping rules: no `enum`, `namespace` or constructor parameter properties, `import type` for type-only imports, and explicit `.ts` extensions in relative imports. [Writing scenarios](docs/06-writing-scenarios.md) covers this, how to choose checkpoints, and how to test existing code.

## Limitations

- Only marked checkpoints are interleaved. Parallel does not control the event loop, timers, network or databases, and the results only cover the model you wrote.
- The number of orderings grows quickly (three actors with three checkpoints each already have 1,680), and there is no schedule reduction yet. Exploration stops at configurable bounds and says so when it does.
- An actor that doesn't reach its next checkpoint within a time limit (10 seconds by default) is reported as stalled. Parallel can ask actors to stop through an `AbortSignal`, but it cannot cancel arbitrary promises or synchronous code. See [execution lifecycle](docs/03-execution-lifecycle.md).
- Exploration assumes the scenario behaves the same every time it runs. Parallel detects differences at checkpoints and stops, but it cannot prove a scenario deterministic. See [nondeterminism and replay](docs/04-nondeterminism-and-replay.md).
- Scenario files run as trusted code, without a sandbox.
- The packages are ES modules (CommonJS code can still `require()` them) and need Node.js 22.18 or later.

## Documentation

- [Writing scenarios](docs/06-writing-scenarios.md): checkpoints, state, invariants, testing real code, common mistakes
- [Execution lifecycle](docs/03-execution-lifecycle.md): actor states, stall detection, cancellation
- [Nondeterminism and replay](docs/04-nondeterminism-and-replay.md): what "complete" means, replay divergence, trace compatibility
- [Packaging](docs/05-packaging.md): package structure, external usage, publishing checklist
- [Requirements](docs/02-requirements.md) and [project vision and roadmap](docs/01-parallel.md)
- [Contributing](CONTRIBUTING.md) and [changelog](CHANGELOG.md)

## License

Apache License 2.0; see [LICENSE](LICENSE).

"Parallel" is a working name. The packages are scoped (`@aliloraf/…`) and the command is `parallel-sim`, because `parallel` is already taken on npm and as a command (GNU Parallel).
