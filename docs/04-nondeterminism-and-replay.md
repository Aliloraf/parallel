# Parallel — Nondeterminism Detection and Replay

**Status:** Implemented (engine, CLI). Applies to trace schema version 1.

This document covers how exploration detects nondeterministic scenarios, what a
"complete" exploration means, and how replay classifies traces it cannot
reproduce. Actor lifecycle, stalls and cancellation are covered in
`03-execution-lifecycle.md`.

## 1. What exploration assumes

Exploration is *stateless*. Each schedule re-runs the scenario from fresh state.
It follows a recorded **prefix** of forced decisions, then chooses freely.

This is only sound if the scenario is deterministic at its scheduling points:
the same prefix must lead to the same eligible actors and checkpoints. Timers,
randomness, I/O, or state kept outside `createState()` can break that
assumption. When they do, siblings can be skipped or invented, and the old
engine still reported the exploration as complete.

## 2. Detection

Each run records its **choice point** at every step: the eligible decisions, in
scenario actor order. Every unexplored sibling branch stores the choice points
of the run that created it, for every step of its prefix.

When a branch is re-executed, the engine compares the observed choice point
with the recorded one at each forced step. Any difference is nondeterminism:

- an actor or checkpoint added or missing;
- a renamed checkpoint;
- the forced decision no longer eligible;
- nothing eligible at all.

Recorded history is deep-frozen. Branches share choice points by reference, so
no run can change another branch's expectations.

On detection, exploration **halts**:

- `haltReason: 'nondeterministic'` and `complete: false`.
- `nondeterminism` reports what diverged:
  - `afterDecisions`: decisions made before the differing step.
  - `prefix`: the forced prefix being re-executed.
  - `decisions`: the decisions actually made.
  - `expected` and `observed`: the recorded and observed choice points.
  - `teardown` and `abandonedWork`: from closing the diverged run.
- All `outcomes` and `failures` collected before the divergence are kept. The
  diverged run is not counted as an explored schedule.
- The diverged run is closed with the same bounded teardown as every other run.
  Abandoned work is reported (`abandonedWork`). The CLI applies its termination
  boundary, so it cannot hang on such work.

The CLI exits with status 1 and prints the expected and observed choices.

### Limits of detection

Detection is limited to **observable differences at controlled scheduling
points**:

- Only forced steps are checked. Depth-first exploration never re-executes the
  free part of a schedule, so nondeterminism after a branch point is only seen
  if a later sibling re-executes that step.
- Nondeterminism that changes state but not the eligible actors and checkpoints
  is not detected. An example is a random value that only affects whether an
  invariant holds.
- Timing-dependent nondeterminism may appear in some runs and not others.
- Passing this check does **not** prove a scenario or application
  deterministic.

## 3. What "complete" means

`complete: true` means that every schedule of the scenario's **modeled**
interleavings was explored within the configured bounds, and that no stall,
abandoned work, nondeterminism or early stop was observed. It does not mean:

- that all real-world behavior was covered: code between checkpoints is not
  interleaved, and uncontrolled I/O and timing are not modeled;
- that the application is correct, or deterministic, outside the model.

## 4. How exploration ends

| Situation | `complete` | `limitReached` | `haltReason` | Run outcome |
|---|---|---|---|---|
| All schedules explored | `true` | `null` | `null` | — |
| `maxSchedules` exhausted | `false` | `'maxSchedules'` | `null` | — |
| A run reached `maxSteps` | `false` | `'maxSteps'` | `null` | `incomplete`, or `actor_error` if an actor failed; `stepLimitReached: true` |
| `stopOnFailure` with schedules left | `false` | `null` | `'stop_on_failure'` | — |
| Stall | `false` | `null` | `'stalled'` | `stalled` |
| Unsettled work after teardown | `false` | `null` | `'abandoned_work'` | — |
| Choice point changed on re-execution | `false` | `null` | `'nondeterministic'` | — (no trace) |

An actor error outranks the step bound. Before this milestone, an actor that
threw in a step-bounded run was hidden as `incomplete` and left out of
`failures`. If `stopOnFailure` stops at the final schedule, nothing was
skipped, so the exploration is complete.

## 5. Replay

`replay()` first validates the trace (section 6). It then executes exactly the
recorded number of decisions and checks each recorded decision as it goes.
Traces do not record choice points, so replay checks that each decision is
eligible rather than comparing whole choice points.

A trace that stopped at the step bound (`stepLimitReached`, or outcome
`incomplete` in older traces) is replayed up to that same bound.

A replay that cannot reproduce the trace returns `status: 'replay_diverged'`
with a human-readable `reason` and a machine-readable `divergence`:

| `divergence.kind` | Meaning |
|---|---|
| `unsupported_schema` | Well-formed trace with a schema version other than 1. |
| `scenario_mismatch` | The trace names a different scenario. |
| `decision_not_eligible` | A recorded decision was not eligible; `eligible` lists what was. |
| `ended_early` | The scenario finished, but the trace continues or recorded a step bound at that point. |
| `continued` | The trace finished naturally, but the scenario still had eligible actors. |
| `result_mismatch` | Same schedule, different result. `fields` names which of `outcome`, `violations`, `errors` and `stall` differ. |

When the run completed, `observed` contains the trace it produced. Actor
errors are compared exactly, including their messages. A scenario whose error
messages contain run-specific data (timestamps, random IDs) will therefore not
replay as identical.

Replay cannot tell a code change from nondeterminism. Both appear as a
divergence.

## 6. Trace validation and compatibility

`validateTrace(value)` checks the structure of a schema-1 trace and throws
`InvalidTraceError`, naming the first invalid field (for example
`Invalid trace: decisions[2].checkpoint must be a non-empty string`).
`replay()` runs it before doing anything else.

Besides field types, it checks these consistency rules:

- `stall` is present exactly when the outcome is `stalled`, and
  `stall.afterDecisions` equals the number of decisions;
- `stepLimitReached`, when present, is `true`, and the outcome is `incomplete`
  or `actor_error`.

Unknown extra fields are ignored. The CLI reports invalid JSON and invalid
traces with exit status 2.

**Compatibility.** Schema version 1 is unchanged except for the optional
`stepLimitReached` field. Traces recorded earlier are accepted as they are,
and missing metadata is never filled in:

- An older trace without `stepLimitReached` and with outcome `incomplete` is
  replayed up to the bound. That outcome was the only way the old engine
  recorded a bounded run.
- The old engine labeled a bounded run in which an actor threw as `incomplete`.
  Replaying such a trace now produces `actor_error`, so it diverges with
  `result_mismatch` on `outcome`. The trace is not reinterpreted.

The repository keeps fixed examples of earlier traces in
`tests/fixtures/traces/` and tests them against these rules.
