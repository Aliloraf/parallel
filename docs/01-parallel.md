# Parallel: vision and roadmap

This document explains what Parallel is trying to become and in which order. The current behavior is described in the README and the other documents in this directory; the requirements for the first release are in [02-requirements.md](02-requirements.md).

## The problem

Many serious bugs only appear when operations run in an unexpected order: two purchases of the last item in stock, two transfers from the same account, a retry that lands after a cancellation. Each operation is correct on its own, and conventional tests run them in one order and pass. The failing order may occur once in thousands of production requests and disappear as soon as someone tries to debug it.

The same kind of problem shows up in booking systems, authentication flows, payment processing, inventory, and anything else where independent requests share state.

## The approach

Parallel makes ordering something you can test systematically:

1. A developer describes a small concurrent situation as a scenario: initial state, a few actors, and invariants that must always hold.
2. The actors mark the points where other work may interleave.
3. Parallel runs the scenario under every ordering of those points that fits within its bounds, from fresh state each time, and checks the invariants.
4. A failure comes with the exact schedule that caused it, and that schedule can be replayed deterministically to debug the bug and to check the fix.

This is systematic concurrency testing, an idea with a long history in research tools and in testing frameworks for other languages. Parallel's aim is to make it practical for application developers working in TypeScript and Node.js: scenarios in plain TypeScript, readable failure reports, replayable traces, and a CLI that fits into CI.

Parallel does not predict production failures and does not prove programs correct. It explores the behaviors of the model a developer writes, reports exactly what it explored, and says so when it couldn't finish.

## Principles

- Correctness of the engine comes first. A wrong "all clear" is worse than no answer, so results never claim more coverage than was achieved.
- Results are honest about their limits: bounds that were hit, stalls, nondeterminism and abandoned work are always reported.
- Everything runs locally. Parallel itself never uploads scenarios or traces; it has no network code. Scenario code is trusted code written by the user, though, and can make network requests of its own.
- Developers stay in control of what is modeled. Parallel only schedules what it is told about, and documents what it cannot see.
- New capabilities are added only when there is a concrete need for them.

## Architecture

The core engine is kept separate from everything around it, so that interfaces and infrastructure can change without touching the scheduling logic:

- The SDK is what scenario authors use: `defineScenario`, checkpoints, cancellation signals.
- The engine schedules actors, explores schedules, checks invariants, and records and replays traces.
- The CLI runs scenarios and replays traces from the command line and in CI.

Later layers, such as isolated execution environments, a report viewer, or a hosted service, would sit on top of these packages without changing them.

## Roadmap

These phases describe direction and order, not dates or commitments.

### 0.1.0

- TypeScript scenario SDK with explicit checkpoints and invariants.
- Depth-first schedule exploration with schedule and step bounds.
- Versioned failure traces and deterministic replay, with structured divergence reports.
- Actor lifecycle management: stall detection, cooperative cancellation, bounded teardown.
- Detection of nondeterministic scenarios.
- The `parallel-sim` CLI: strict argument parsing, exit codes that separate failures, incomplete exploration, nondeterminism and runtime errors, and versioned JSON reports.
- npm packages, tested on Linux and Windows.

### Unreleased

- A worked application example ([`examples/shop/`](../examples/shop)): an order service with inventory overselling, duplicate payment processing and double reservation, each with a corrected implementation, tested through its own business functions rather than rewritten as scenarios.
- `attempt()` and `Attempt<T>` in the SDK, so an expected application rejection becomes scenario data instead of an `actor_error` that suppresses the invariants, while cancellation still reaches the actor.
- A practical guide to instrumenting existing code ([testing application code](07-testing-application-code.md)).

These make the existing scheduler usable on ordinary application code. They do not extend what it controls: the items below are still unimplemented.

### Next: developer workflow

- Trace format v2, recording choice points and run configuration so that replay can detect changed behavior more precisely.
- Invariants that can be checked at intermediate steps, not only at the end.
- Shrinking failing schedules to the fewest steps that still fail.
- Search strategies beyond plain depth-first search, such as seeded random exploration and partial-order reduction to skip equivalent schedules.

### Later: real application testing

- Running actors in worker threads, so that stuck actors can actually be stopped and synchronous infinite loops detected.
- Scheduler-controlled primitives (locks, channels, virtual time), so that deadlocks become a deterministic outcome instead of a stall.
- Selected integrations with real application stacks: HTTP handlers, disposable databases, controlled timers and network delays.

### Possibly: visualization and a hosted service

- A local report viewer showing timelines of failing schedules.
- Hosted execution for teams: isolated workers, CI integration, failure history. This requires sandboxing untrusted code, which the local tool deliberately does not attempt.

## Technical challenges

- State-space explosion. The number of orderings grows combinatorially with actors and checkpoints, so Parallel needs bounds, honest reporting of what was explored, and eventually techniques that skip equivalent orderings.
- Determinism. Replay is only reliable when everything that affects scheduling is controlled. Timers, randomness and I/O have to be modeled, controlled, or at least detected.
- Isolation. Each schedule must start from the same state. In-memory state is easy; processes, databases and networks are not.
- Correctness of the scheduler. A bug in exploration would silently miss schedules, so the engine itself needs extensive tests.
- Real-world adoption. Instrumenting existing code with checkpoints must stay simple enough that developers actually do it. The approach so far is an optional callback threaded through the data-access layer; `examples/shop/` is the worked case.

## Users

The first audience is developers building backend logic in TypeScript and Node.js where several requests or jobs can act on the same data: APIs, payment and booking flows, inventory, job queues. Maintainers who want a reproducible regression test for a race they've already seen are a second group.

## Commercial direction

The engine, SDK and CLI are open source under the Apache License 2.0 and will remain usable locally for free. A possible commercial offering is hosted execution and team features (parallel workers, CI reporting, failure history, collaboration). Whether that makes sense depends on real users and real demand, and it will not take priority over a reliable engine.
