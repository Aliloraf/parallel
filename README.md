# Parallel

**A local-first, deterministic concurrency testing engine for instrumented TypeScript programs.**

Parallel explores possible orderings of explicitly controlled asynchronous operations and checks user-defined invariants. Its first example demonstrates how two customers can both purchase the last item in stock.

> **Status: early proof of concept, not release v0.1.** The current prototype has a working scheduler, schedule exploration, traces, replay, a basic demo CLI and tests. Full scenario loading, general failure handling, and remaining SRS requirements are still planned.

## Requirements

- Node.js 22.16+ (Node 22 is used for native TypeScript type stripping)
- npm
- TypeScript 5.8+ for type checking (installed via `npm install`)

## Getting started

```bash
npm install
npm test
npm run typecheck
npm run demo
npm run demo:fixed
```

`npm run demo` deliberately returns **exit code 1** because it discovers a bug. `npm run demo:fixed` should return **exit code 0**.

Save a trace and replay it:

```bash
node --experimental-strip-types packages/cli/src/cli.ts test inventory-buggy --trace-out traces/failure.json
node --experimental-strip-types packages/cli/src/cli.ts replay traces/failure.json
```

Replaying a *known failure* returns exit code 1 intentionally (useful for CI). The trace is local and could contain application-specific data. Traces are gitignored by default.

For JSON output:

```bash
node --experimental-strip-types packages/cli/src/cli.ts test inventory-fixed --json
```

## How the prototype works

1. A scenario declares a `createState` factory, actor functions and invariants.
2. Actors pause at `await checkpoint('name')` before taking the next controlled step.
3. Parallel selects an actor to resume and records the decision.
4. It restarts from fresh state to explore alternate scheduling decisions.
5. It evaluates invariants after a run and can replay a failure by following saved decisions.

**Important:** The engine controls *only* explicitly declared checkpoints. Work between checkpoints is effectively atomic as far as the scheduler is concerned. Unmanaged `await`, timers, network calls, randomness, or external I/O can invalidate repeatability or hang this prototype. Run only trusted scenarios. It does **not** sandbox code or prove an arbitrary app is bug-free.

The six expected interleavings of two actors with two checkpoints each are covered by automated tests.

## Repository layout

```text
packages/sdk/src/        Typed scenario definitions and cooperative checkpoint API
packages/engine/src/     Exploration, trace generation, and replay
packages/cli/src/        Local test / replay CLI (bundled example scenarios)
examples/inventory/src/  Buggy and fixed inventory workflows
tests/                   Automated tests
docs/02-requirements.md  Draft SRS, target requirements for v0.1
```

## Next steps

- Extend the CLI to load developer-supplied scenario files.
- Define a robust cancellation/timeout contract for unmanaged asynchronous work.
- Cover additional error cases, divergence, and trace compatibility.
- Add package boundaries, linting, and usage-focused SDK documentation.
- Investigate schedule-reduction techniques after correctness is demonstrated.

## Naming and licensing

`Parallel` is a working project name. Check existing products, npm package names and trademarks before publishing or monetizing. No open-source license has been chosen yet; add one after deciding how the project will be distributed.
