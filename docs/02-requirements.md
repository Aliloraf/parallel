# Parallel — Software Requirements Specification

**Document ID:** PAR-SRS-001  
**Version:** 0.1 (Draft)  
**Date:** 2026-10-17  
**Project:** Parallel  
**Initial release:** Core simulation engine (MVP / v0.1)  
**Status:** Draft requirements; initial prototype in progress (v0.1 not complete)

---

## 1. Purpose of This Document

This Software Requirements Specification (SRS) defines what **Parallel** must do, the constraints under which it must operate, and how its first release will be evaluated. It is intended to guide architecture, implementation, testing, and technical decisions. Requirements labeled **MUST** are mandatory for v0.1; items marked **SHOULD** are desirable but not release blockers. Ideas explicitly designated **Future** are outside v0.1.

This document specifies *observable behavior* rather than committing to a particular internal algorithm. Architecture and algorithm choices will be documented separately.

## 2. Product Summary

Parallel is a developer tool for discovering concurrency defects by systematically exploring possible orderings of **explicitly controlled operations** in a software scenario. A developer defines the initial state, concurrent actors, scheduling checkpoints, and properties that must hold. Parallel executes multiple schedules, detects property violations, produces an understandable failure trace, and replays a failing schedule.

**Problem:** A program can pass normal tests but fail when independent operations interleave in an unexpected order. Such failures can be rare and difficult to reproduce.

**Initial value proposition:** Help TypeScript/Node.js developers detect and reproduce application-level race conditions without manually coordinating precise timing.

**Important limitation:** Parallel v0.1 is a *cooperative, instrumented scheduler*, not a whole-program model checker. It explores only execution choices exposed through its SDK. It cannot establish that an arbitrary uninstrumented application is race-free, and it does not predict real-world failures with certainty.

## 3. Target Users and Primary Use Cases

**Primary user:** A developer building asynchronous TypeScript or JavaScript application logic who wants to test concurrent access to shared state.

**Secondary user:** A maintainer or test engineer who wants a reproducible regression test for a known race condition.

| ID | Use case | Intended outcome |
|---|---|---|
| UC-01 | Create a concurrency scenario | Define initial state, multiple actors, checkpoints, and an invariant in TypeScript. |
| UC-02 | Explore schedules | Run the scenario under multiple permitted actor interleavings. |
| UC-03 | Detect a bug | Identify an execution that violates a stated invariant. |
| UC-04 | Investigate a bug | Inspect an ordered trace describing actor scheduling and the violated property. |
| UC-05 | Reproduce a bug | Replay the recorded schedule against the same scenario and initial conditions. |
| UC-06 | Verify a fix | Rerun exploration after correcting the example and observe no violations within the explored schedules. |

## 4. Scope and Release Boundaries

### 4.1 Included in v0.1 (MVP)

- A TypeScript SDK for defining and running local scenarios.
- At least two asynchronous actors in a scenario, with actor-local program order preserved.
- Explicit, named scheduling checkpoints and a controlled starting point for each actor.
- Fresh, reproducible in-memory initial state for each schedule.
- Systematic exploration of permitted interleavings for bounded finite scenarios.
- User-defined assertions/invariants evaluated on completed executions.
- Detection and reporting of invariant violations and actor execution errors.
- A structured, versioned execution trace with schedule decisions.
- Deterministic replay for supported, fully controlled scenarios.
- A local CLI for test execution and replay, including machine-readable output.
- An example inventory overselling bug and a corrected version.
- Automated unit and integration tests and clear developer documentation.

### 4.2 Explicitly excluded from v0.1

- Automatic instrumentation of arbitrary application code.
- General control of Node.js's event loop, timers, threads, or all Promise resolutions.
- Real database, HTTP, external service, or network simulation.
- Docker-based sandboxing and executing untrusted customer code.
- Distributed simulation across machines.
- AI-based test generation or natural-language bug explanations.
- A web dashboard, accounts, billing, subscriptions, or hosted execution.
- A guarantee of exhaustive verification of all production behaviors.

These exclusions are deliberate: v0.1 must prove the scheduler and replay semantics before expanding its execution environment.

## 5. Terminology

| Term | Definition |
|---|---|
| **Scenario** | A test definition containing a state factory, actors, checkpoints, and invariants. |
| **Actor** | An independently scheduled logical operation, represented by an async function in v0.1. |
| **Checkpoint** | A named cooperative yield at which the scheduler can pause/resume an actor. |
| **Atomic segment** | Code executed between two controlled scheduling boundaries; treated as indivisible by the v0.1 scheduler. |
| **Schedule** | An ordered series of scheduler decisions selecting eligible actors to advance. |
| **Invariant** | A user-provided correctness assertion evaluated against the scenario outcome. |
| **Trace** | A structured record of the initial scenario identity, scheduling decisions, and results. |
| **Replay** | Re-execution guided by a previously recorded schedule. |
| **Bound** | A configured limit on schedules, steps, or execution time. |
| **Coverage** | The subset of modeled schedules actually explored, *not* general source-code or real-world behavior coverage. |

## 6. Functional Requirements

The following requirements are mandatory for v0.1 unless noted otherwise. Every ID must be traceable to one or more automated tests.

### 6.1 Scenario Definition and Validation

**FR-001 — Typed scenario API.** The SDK MUST allow developers to define a named scenario in TypeScript, including a function that creates fresh initial state, a set of named actors, and at least one invariant.

**FR-002 — Multiple actors.** The engine MUST support two or more actors in a single scenario and preserve each actor's own operation order.

**FR-003 — Controlled execution boundaries.** The SDK MUST expose named checkpoints where actors yield control to the scheduler. Actors MUST NOT execute their first modeled step before the scheduler authorizes it.

**FR-004 — Input validation.** The engine MUST reject invalid scenario definitions with actionable errors, including missing actors, duplicate actor identifiers, invalid execution bounds, and missing required invariants.

**FR-005 — Explicit model limitations.** Documentation MUST state that code between checkpoints is not interleaved by Parallel and that uncontrolled asynchronous side effects may break replay determinism.

### 6.2 Execution and State Management

**FR-006 — Fresh initial state.** Each explored schedule MUST begin with a new state created by the scenario's state factory; state mutated in one run MUST NOT leak into another.

**FR-007 — Scheduler-owned progress.** At each controlled scheduling boundary, the engine MUST select only an actor eligible to advance; a paused actor MUST NOT advance before being resumed.

**FR-008 — Finite schedule exploration.** For finite, supported scenarios, the engine MUST systematically enumerate distinct permitted interleavings up to configured bounds. Exhaustive enumeration is required only when the search completes without hitting a bound or unsupported behavior.

**FR-009 — Repeatable exploration order.** Given the same scenario, configuration, and supported deterministic operations, exploration MUST produce the same schedule order and outcomes across repeated runs in the same supported environment.

**FR-010 — Execution bounds.** The engine MUST support a maximum number of explored schedules and a maximum number of controlled scheduling steps per execution. A run MUST report if either limit prevented completion. A wall-clock timeout MAY be added for safety but does not constitute deterministic scheduling.

**FR-011 — Execution outcomes.** Each explored schedule MUST be classified as `passed`, `invariant_failed`, `actor_error`, or `incomplete` (for example, because a bound was hit). The engine MUST NOT count an incomplete run as passed.

### 6.3 Invariants and Failure Detection

**FR-012 — Invariant evaluation.** After a scenario's actors have completed, the engine MUST evaluate each declared invariant against the resulting state and recorded outcomes.

**FR-013 — Failure details.** If an invariant fails, the report MUST identify the scenario, invariant, observed values or assertion message, and schedule that produced the failure.

**FR-014 — Actor errors.** Unhandled errors in an actor MUST be reported distinctly from invariant failures, with sufficient context to investigate them.

**FR-015 — Configurable stop behavior.** The engine SHOULD support stopping on the first discovered failure or continuing until the exploration bound is reached.

### 6.4 Tracing and Replay

**FR-016 — Structured trace.** For each discovered failure, the engine MUST be able to export a machine-readable trace containing a schema version, scenario identifier, configuration required for replay, ordered actor decisions, checkpoint identifiers, and final outcome.

**FR-017 — Human-readable output.** A failed exploration MUST provide an ordered timeline that developers can read without inspecting internal engine state.

**FR-018 — Deterministic replay.** Given the same compatible scenario implementation, fresh initial state, and controlled environment, replay MUST follow the saved actor decisions and reproduce the same failure outcome.

**FR-019 — Replay divergence detection.** If a trace cannot be replayed because actors, checkpoints, or execution paths differ, the engine MUST return an explicit `replay_diverged` result instead of claiming success.

**FR-020 — Stable trace format.** Trace files MUST include a schema version. Format changes that are incompatible with earlier versions MUST be explicitly detected or migrated.

### 6.5 CLI and Integration

**FR-021 — Local command-line use.** A CLI MUST provide commands to run a scenario and replay an exported trace. A command name such as `parallel test` / `parallel replay` is provisional pending package-name and command collision checks.

**FR-022 — Process exit status.** The CLI MUST exit successfully only if the run completed without detected failures or execution errors; detected failures and incomplete/error conditions MUST use non-zero exit statuses, documented for CI use.

**FR-023 — Machine-readable summary.** The CLI MUST support JSON output containing number of explored schedules, number of failures, exploration completion status, limits reached, and trace paths.

**FR-024 — Example scenarios.** The repository MUST contain an intentionally buggy shared-inventory scenario and a corrected version, with commands that demonstrate detection, replay, and verification of the fix.

## 7. Non-Functional Requirements

**NFR-001 — Correctness first.** The scheduler MUST never claim a scenario was exhaustively explored if a limit, unsupported operation, or execution error interrupted exploration.

**NFR-002 — Testability.** The engine MUST have automated tests for actor ordering, checkpoint suspension, state isolation, enumeration, bounds, invariant checking, tracing, replay, and replay divergence.

**NFR-003 — Reproducibility.** The reference inventory failure trace MUST replay with the same violation in at least 10 consecutive runs under a fixed supported Node.js runtime and unchanged code.

**NFR-004 — Performance baseline.** The release MUST be able to enumerate the six legal interleavings of two actors with two ordered modeled steps each on a developer laptop. Performance beyond this baseline will be measured, not assumed or guaranteed.

**NFR-005 — Developer experience.** A new contributor SHOULD be able to install dependencies and reproduce the demonstration by following a documented set of commands. Error messages MUST identify the failing scenario and relevant actor/checkpoint where possible.

**NFR-006 — Maintainability.** The scheduler, scenario SDK, trace/replay handling, and CLI MUST have clear module boundaries and independently testable interfaces. The codebase MUST use TypeScript strict type checking and automated linting/formatting.

**NFR-007 — Local-first privacy.** v0.1 MUST run locally and MUST NOT transmit source code or scenario data to a hosted service. Trace contents MUST be documented because they can contain application-specific data.

**NFR-008 — Security boundary.** v0.1 MUST assume scenario code is trusted code supplied by the developer; it MUST NOT advertise a sandbox for untrusted code. Future hosted execution will require separate security requirements.

**NFR-009 — Portability.** The project MUST document supported Node.js and operating-system versions, and automated tests MUST run on at least one documented target platform. Broader operating-system support is a future goal.

**NFR-010 — Documentation.** The repository MUST include setup, scenario-writing, execution/replay, known limitations, and troubleshooting documentation.

## 8. Conceptual Inputs and Outputs

### 8.1 Scenario input (conceptual API)

The following illustrates intended behavior; the SDK syntax is **not yet finalized**:

```ts
const scenario = defineScenario({
  name: "inventory-oversell",
  createState: () => ({ stock: 1, successfulPurchases: 0 }),
  actors: {
    customerA: purchase,
    customerB: purchase,
  },
  invariants: [
    state => state.successfulPurchases <= 1,
  ],
});
```

The `purchase` operation will use scheduler-controlled checkpoints before modeled read/write steps. The engine will not infer these scheduling points automatically.

### 8.2 Failure report (conceptual output)

```text
Scenario: inventory-oversell
Status: INVARIANT FAILED
Initial stock: 1

Schedule:
  1. customerA reads stock = 1
  2. customerB reads stock = 1
  3. customerA completes purchase
  4. customerB completes purchase

Violation: successfulPurchases <= 1
Observed: 2
Trace: traces/inventory-oversell-failure.json
Replay: <cli> replay traces/inventory-oversell-failure.json
```

The trace MUST distinguish recorded scheduling decisions from optional explanatory application events; it must not invent operations or claim to have observed uninstrumented behavior.

## 9. Acceptance Criteria for v0.1

These criteria determine whether the first release is complete.

| ID | Acceptance test | Pass condition |
|---|---|---|
| AC-01 | Define and execute a two-actor scenario | Scenario runs with a typed API and each actor respects its own step order. |
| AC-02 | Enumerate simple schedules | For two actors with two modeled steps each and no extra constraints, the engine explores exactly **6** unique interleavings when unbounded. |
| AC-03 | Isolate state | Mutations from a previously explored schedule do not affect the initial state of the next. |
| AC-04 | Discover inventory race | At least one explored schedule produces two successful purchases from one item and fails the invariant. |
| AC-05 | Trace failure | Exported trace identifies the actor decision order and failing invariant. |
| AC-06 | Replay consistently | Replaying the stored failure 10 consecutive times reproduces the violation with unchanged code/environment. |
| AC-07 | Detect incompatible replay | A modified checkpoint sequence leads to an explicit replay-diverged outcome. |
| AC-08 | Verify corrected implementation | The fixed inventory example passes every explored schedule in the modeled, unbounded two-actor case. |
| AC-09 | Enforce bounds honestly | Hitting an execution or schedule bound yields an incomplete exploration summary, never an exhaustive success claim. |
| AC-10 | CLI and CI behavior | CLI emits human-readable and JSON results; failure/incomplete runs return appropriate non-zero exit codes. |
| AC-11 | Documentation and test suite | Automated tests pass and a contributor can reproduce AC-04 through AC-08 using documented commands. |

**Interpretation:** Passing all explored schedules means *no bug was found in the modeled state space*. It is not a proof of correctness for the full application.

## 10. Future Requirements (Not Part of v0.1)

| Phase | Candidate capabilities |
|---|---|
| v0.2 — Developer workflow | More expressive assertions, improved search strategies, trace minimization, reusable scenarios, CI workflow templates. |
| v0.3 — Real-world integrations | Selected HTTP workflows, disposable PostgreSQL environments, controlled timers/network delays, selected Node.js instrumentation. |
| v0.4 — Visualization | React-based execution timeline, failure comparison, scenario explorer, local report viewer. |
| v1.x — Hosted product | Secure isolated code execution, job queues, GitHub integration, organization accounts, metering, collaboration, billing. |

Version numbers here are indicative, not release commitments. Future scope will be revisited after the initial engine is validated.

## 11. Assumptions, Risks, and Constraints

**A-01:** Developers are willing to add checkpoints to code or write an instrumented model of the behavior they want to test.

**A-02:** The MVP is implemented and evaluated locally, using trusted scenario code.

**R-01 — State-space explosion:** The number of interleavings grows rapidly; explicit bounds and honest completeness reporting are essential.

**R-02 — False confidence:** Users may mistake explored-schedule success for a guarantee. Documentation and reports must state the tested scope and limits.

**R-03 — Uncontrolled nondeterminism:** Timers, random values, external I/O, and uninstrumented asynchronous operations can invalidate deterministic replay. MVP examples must avoid or control them.

**R-04 — Instrumentation complexity:** Poorly placed checkpoints may omit important races. The SDK must make boundaries explicit and explain their effects.

**R-05 — Naming conflict:** “Parallel” is a broad name used by other software; CLI, package, repository, and product naming must be checked before public release.

**C-01 — Scope constraint:** The MVP must remain an engine-first, local TypeScript project. No dashboard, cloud infrastructure, or AI layer may be treated as a prerequisite to acceptance.

## 12. Open Design Decisions

These decisions belong in the architecture document and must be settled before the corresponding implementation work:

1. How will actors be resumed at the beginning and at each checkpoint while preventing unintended progress?
2. What exact SDK API makes read/write atomic segments visible to the scheduler?
3. Which exploration strategy will enumerate bounded schedules first (e.g., depth-first search)?
4. How will the engine identify logically identical states or redundant schedules, if at all?
5. What trace schema and compatibility policy will support reliable replay?
6. What guarantees can the engine make about timeout, deadlock, and external asynchronous work?
7. What CLI executable and package namespace avoid collisions with existing “parallel” tools?

## 13. Definition of Done

**Parallel v0.1 is done when** all mandatory functional requirements, all applicable non-functional requirements, and every acceptance criterion in Section 9 have been demonstrated through automated tests and documented examples. Any deviation must be recorded explicitly, and incomplete coverage must not be described as success.

---

**Document maintenance:** Keep requirement IDs stable after implementation begins. Record changes in version control, and update acceptance tests whenever observable requirements change.
