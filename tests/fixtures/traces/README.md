# Trace compatibility fixtures

These traces were produced by the engine as of commit `80134a3`, before
nondeterminism detection was added. They are fixed inputs for compatibility
tests: do **not** regenerate them with a newer engine. The scenarios they replay
against are in `../scenarios.ts`, `examples/inventory` and `examples/counter`.

| File | Recorded with |
|---|---|
| `inventory-invariant-failed.json` | `explore(inventoryScenario())`, first failure |
| `counter-invariant-failed.json` | `explore(counter)`, first failure |
| `inventory-incomplete.json` | `explore(inventoryScenario(), { maxSteps: 2, maxSchedules: 1 })` |
| `stall.json` | `explore(stallFixture, { stepTimeoutMs: 50 })`, first failure |
| `bounded-error-incomplete.json` | `explore(boundedErrorFixture, { maxSteps: 3, maxSchedules: 1 })`; an actor error that the old engine classified as `incomplete` |
| `cleanup-error-incomplete.json` | `explore(cleanupErrorFixture, { maxSteps: 1, maxSchedules: 1 })` |
