# Nondeterminism, completeness and replay

This document covers how exploration detects scenarios that don't behave the same way every time, what a "complete" exploration does and doesn't mean, the trace format, and how replay reports traces it can't reproduce. Stalls and cancellation are covered in [execution lifecycle](03-execution-lifecycle.md).

## What exploration assumes

Exploration is stateless: every schedule re-runs the scenario from fresh state, follows a recorded prefix of decisions, and then chooses freely. That only works if the same prefix always leads to the same eligible actors and checkpoints. Timers, randomness, I/O and state kept outside `createState()` can break that assumption, and when they do, exploration can skip orderings or invent ones that don't exist.

## Detecting nondeterminism

At every step, a run records its choice point: the eligible actor/checkpoint pairs, in declaration order. Each unexplored branch keeps the choice points of the run that created it for every step of its prefix. When the branch is re-run, the engine compares each forced step's choice point with the recorded one. Any difference counts as nondeterminism: an actor or checkpoint that appeared or disappeared, a renamed checkpoint, a recorded decision that is no longer eligible, or no eligible actor at all.

The recorded history is deep-frozen. Branches share choice points by reference, but no run can modify another branch's expectations.

When the engine detects nondeterminism, exploration stops with `haltReason: 'nondeterministic'` and `complete: false`. The `nondeterminism` field of the result describes it:

| Field | Contents |
|---|---|
| `afterDecisions` | Number of decisions made before the step that differed. |
| `prefix` | The recorded prefix that was being re-run. |
| `decisions` | The decisions actually made before the difference. |
| `expected`, `observed` | The recorded and the observed choice point. |
| `teardown`, `abandonedWork` | From closing the diverged run. |

All outcomes and failures found before that point are kept. The diverged run isn't counted as an explored schedule, and it is closed with the usual bounded teardown, so abandoned work is reported and the CLI can't hang on it. The CLI prints the expected and observed choices and exits with status 1.

Detection only covers differences visible at checkpoints:

- Only forced steps are compared. Depth-first exploration never re-runs the free part of a schedule, so a difference after a branch point is only noticed if a later branch re-runs that step.
- A difference in state that doesn't change the eligible actors and checkpoints goes unnoticed, for example a random value that only decides whether an invariant holds.
- Timing-dependent behavior may differ in some runs and not in others.

Passing this check does not prove a scenario, let alone an application, deterministic.

## What "complete" means

`complete: true` means every interleaving of the scenario's checkpoints was explored within the configured bounds, and no stall, abandoned work, nondeterminism or early stop occurred. It says nothing about behavior outside the model: code between checkpoints isn't interleaved, and I/O and timing aren't controlled.

How exploration can end:

| Situation | `complete` | `limitReached` | `haltReason` | Outcome of the last run |
|---|---|---|---|---|
| All schedules explored | `true` | `null` | `null` | any |
| `maxSchedules` reached | `false` | `'maxSchedules'` | `null` | any |
| A run reached `maxSteps` | `false` | `'maxSteps'` | `null` | `incomplete`, or `actor_error` if an actor threw; `stepLimitReached: true` |
| `stopOnFailure`, schedules left | `false` | `null` | `'stop_on_failure'` | a failure |
| An actor stalled | `false` | `null` | `'stalled'` | `stalled` |
| Work left unsettled after teardown | `false` | `null` | `'abandoned_work'` | any |
| A choice point changed | `false` | `null` | `'nondeterministic'` | none; the diverged run produces no trace |

An actor error takes precedence over the step bound: a run that hit `maxSteps` after an actor threw is an `actor_error` and counts as a failure. If `stopOnFailure` stops at the last schedule, nothing was skipped and the exploration is complete.

## Traces

A trace is the JSON record of one schedule. `--trace-out` writes the first failing one, and `explore()` returns all of them in `outcomes` (failures also in `failures`).

```json
{
  "schemaVersion": 1,
  "scenario": "last-item",
  "decisions": [
    { "actor": "bob", "checkpoint": "read-stock" },
    { "actor": "alice", "checkpoint": "read-stock" },
    { "actor": "alice", "checkpoint": "commit" },
    { "actor": "bob", "checkpoint": "commit" }
  ],
  "outcome": "invariant_failed",
  "violations": [{ "name": "no-overselling", "detail": "sold 2 items, but only 1 was in stock" }],
  "errors": []
}
```

| Field | Contents |
|---|---|
| `schemaVersion` | Always `1` for now. |
| `scenario` | The scenario's `name`. |
| `decisions` | The scheduling decisions in order: which actor was resumed at which checkpoint. |
| `outcome` | `passed`, `invariant_failed`, `actor_error`, `incomplete` or `stalled`. |
| `violations` | Failed invariants and their messages. |
| `errors` | Errors thrown by actors (or by invariants, as actor `(invariant)`). |
| `stall` | Optional, only for `stalled`. See [execution lifecycle](03-execution-lifecycle.md#trace-fields). |
| `teardown` | Optional, only when teardown problems occurred. |
| `stepLimitReached` | Optional, `true` when the run stopped at `maxSteps` with actors still eligible. |

Traces contain your scenario's checkpoint names, invariant messages and error messages, which may include application data.

## Replay

`replay()` validates the trace, then runs exactly as many decisions as the trace records, checking at each step that the recorded decision is eligible. Traces don't store whole choice points, so replay can't notice an extra eligible actor the way exploration can. A trace that stopped at the step limit (`stepLimitReached`, or outcome `incomplete` in traces written before that field existed) is replayed up to the same limit.

A replay that reproduces the trace returns `status: 'replayed'`. Otherwise it returns `status: 'replay_diverged'` with a `reason` for people and a `divergence` for programs:

| `divergence.kind` | Meaning |
|---|---|
| `unsupported_schema` | A well-formed trace with a schema version other than 1. |
| `scenario_mismatch` | The trace belongs to a different scenario. |
| `decision_not_eligible` | A recorded decision wasn't possible; `eligible` lists what was. |
| `ended_early` | The scenario finished where the trace continues or recorded a step limit. |
| `continued` | The trace ended naturally, but the scenario still had eligible actors. |
| `result_mismatch` | Same schedule, different result; `fields` lists which of `outcome`, `violations`, `errors` and `stall` differ. |

When the replayed run finished, `observed` holds the trace it produced. Errors are compared including their messages, so errors containing timestamps or random IDs won't replay as identical. Replay can't tell whether a divergence comes from a code change or from nondeterminism.

## Validation and compatibility

`validateTrace(value)` checks a trace's structure and throws `InvalidTraceError` naming the first invalid field, for example `Invalid trace: decisions[2].checkpoint must be a non-empty string`. `replay()` calls it first. Besides the field types, it checks that `stall` is present exactly when the outcome is `stalled` (with `afterDecisions` equal to the number of decisions), and that `stepLimitReached`, when present, is `true` on an `incomplete` or `actor_error` trace. Unknown extra fields are ignored. The CLI reports invalid JSON and invalid traces with exit status 2.

The format has stayed at schema version 1 so far; fields added since the first version are optional. Older traces are accepted as they are, and missing information is never filled in:

- A trace without `stepLimitReached` whose outcome is `incomplete` is replayed up to its last decision, since `incomplete` was the only way earlier versions recorded a bounded run.
- Earlier versions labeled a bounded run in which an actor threw as `incomplete`. Replaying such a trace now yields `actor_error`, so it diverges with `result_mismatch` on `outcome` instead of being silently reinterpreted.

`tests/fixtures/traces/` holds traces recorded by earlier versions, and the tests check them against these rules.
