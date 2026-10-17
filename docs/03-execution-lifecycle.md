# Parallel — Execution Lifecycle, Stalls and Cancellation

**Status:** Implemented (engine, SDK, CLI). Applies to trace schema version 1.

This document describes how the engine runs one schedule, how it detects actors
that stop making progress, and what it can and cannot do about them. It answers
open design decision 6 of `02-requirements.md` for *stalls*; deterministic
deadlock detection is not implemented yet.

## 1. Running a schedule

1. A fresh state is created and every actor's `run()` is started.
2. The scheduler waits for **quiescence**: no actor is executing. Each actor is
   either paused at a checkpoint or has finished. Before the scheduler trusts
   that observation, it waits one macrotask turn so queued microtasks can run.
   For example, an actor that returns right after an un-awaited checkpoint
   gets detected before the scheduler acts on that checkpoint.
3. The scheduler selects one paused actor (the saved prefix, or the first
   eligible actor in scenario order), records the decision and resumes it.
4. Steps 2–3 repeat until no actor is paused, `maxSteps` is reached, or an actor
   stalls. The run is then **closed** (section 4).

## 2. Actor states

```text
running --checkpoint()--> waiting --resume--> running
running --run() resolves--> completed        running --run() throws--> errored
waiting --run() settles (un-awaited checkpoint)--> errored
running --step budget elapses--> stalled     (abandoned; never resumed)
waiting --run closes--> cancelling --> cancelled | parked
cancelling | parked --task unsettled after teardown budget--> unresponsive
```

| State | Meaning |
|---|---|
| `running` | Executing code between checkpoints (or before its first checkpoint). |
| `waiting` | Paused at a checkpoint; eligible for scheduling. |
| `completed` / `errored` | `run()` resolved / threw. Finishing while a checkpoint is still pending is an error (`missing await?`). |
| `stalled` | Still `running` when the step budget elapsed. |
| `cancelling` | Was paused when the run closed; it has been sent cancellation. |
| `cancelled` | Settled after cancellation. |
| `parked` | Called `checkpoint()` again after cancellation. That call never settles, but the actor's task may still be active. |
| `unresponsive` | Its task (`cancelling` or `parked`) had not settled when the teardown budget elapsed. |

Checkpoint misuse is reported as an `actor_error`:

- empty names;
- overlapping checkpoints in one actor;
- an un-awaited checkpoint the actor never returns to;
- calling `checkpoint()` through a context after its actor finished.

## 3. Stall detection (`stepTimeoutMs`)

Each wait for quiescence has a wall-clock budget:

- `stepTimeoutMs` defaults to **10 000 ms**.
- It must be an integer from 1 to 2 147 483 647, the largest delay `setTimeout` honors.
- Any other value is rejected.

If the budget elapses while an actor is still `running`, that actor is
`stalled`, and the schedule's outcome is `stalled`:

- A stalled schedule is reported as a failure.
- Exploration **halts immediately** (`haltReason: 'stalled'`, `complete: false`).
- No further schedules run while abandoned work may still be active.

The waiting timer keeps Node's event loop alive. An actor blocked on a promise
that can never settle is therefore reported. It no longer lets the process
exit with no result and status 0.

The timeout is a safety net and is **not** part of deterministic scheduling.
Whether a slow actor counts as stalled depends on machine speed and load.

## 4. Closing a run

Every run is closed, however it ended:

1. Scheduling stops and the run is fenced. Later activity from its actors
   cannot change scheduler state, a later run, or the returned trace.
2. `context.signal` is aborted with a `SimulationCancelledError` reason.
3. Each paused actor's pending checkpoint rejects with `SimulationCancelledError`.
   A stalled actor that later reaches a checkpoint receives the same error. Any
   further `checkpoint()` call after that is parked (it never settles), so a
   retry loop can neither spin nor hang teardown.
4. The engine waits, again bounded by `stepTimeoutMs`, for **every actor task**
   (the promise returned by `run()`) to settle. It never waits on them
   indefinitely. Whether each task had settled is recorded once, when the run
   is finalized. The stall report, the teardown entries and `abandonedWork`
   all come from that single record.

Parking suspends only the checkpoint call, not necessarily the actor. An actor
that raced the parked checkpoint against other work (for example with
`Promise.race`) keeps running. A parked actor whose task has not settled
therefore also counts as abandoned work.

Problems during teardown are recorded in the trace's optional `teardown`
field. The run's outcome is not changed:

| `status` | Meaning |
|---|---|
| `ignored-cancellation` | The actor checkpointed again after cancellation. That call was parked. If the task then fails to settle, an `unresponsive` entry follows. |
| `cleanup-error` | The actor threw a non-cancellation error while handling cancellation. |
| `unresponsive` | The actor's task did not settle within the teardown budget. Its work was abandoned and exploration halts (`haltReason: 'abandoned_work'`). |

A stalled actor that does not respond reaches its budget twice: once to detect
the stall and once during teardown. The worst-case cost of such a stall is
therefore about `2 × stepTimeoutMs`.

## 5. Detection is not cancellation

The engine **detects** that an actor stopped making progress. It cannot
**cancel** what the actor is doing: JavaScript has no way to force an
arbitrary promise, timer, socket or synchronous loop to stop. The engine
offers cooperative cancellation only:

- `context.signal`, which actors can pass to cancellable APIs
  (`fetch(url, { signal })`, `AbortSignal`-aware libraries), or listen to;
- a `SimulationCancelledError` rejection at the next checkpoint.

When an actor does not cooperate, its work is **abandoned**:

- It keeps running in the background.
- It may hold handles open, log, or modify anything outside the state that
  `createState()` creates.
- `ExploreResult.abandonedWork` is `true`.
- In the trace, the stalled actor shows `settledAfterAbort: false`, or a
  teardown entry shows `unresponsive`.
- `leavesAbandonedWork(trace)` tests this for a single trace.
- `replay()` reports the same condition as `abandonedWork` on every result,
  including diverged replays.

**Safety guarantee.** Exploration never starts another schedule while an actor
task from an earlier schedule is unsettled. This covers the actor's `run()`
task only. Work an actor detaches from that task (an un-awaited promise, a
`setInterval`) is invisible to the engine, even after the actor completes.

Not detectable in-process:

- A synchronous infinite loop, or an endless chain of microtasks, blocks the
  event loop. That includes the stall timer, so the engine cannot detect
  either case. Doing so requires running actors in a separate thread or
  process (planned worker isolation).
- An un-awaited checkpoint followed by more unmanaged asynchronous work looks
  like a paused actor. It is detected only if the actor finishes before the
  scheduler acts.

Other known limitations:

- **Parked actors are treated conservatively.** The engine cannot tell an
  actor frozen on a parked checkpoint from one that is still active. Any
  actor that ignores cancellation therefore costs the full teardown budget
  and halts exploration, unless its task settles within that budget.
- **Divergence and engine failures still close the run.** When
  nondeterminism is detected or replay diverges, the run is closed with the
  same bounded teardown, and its abandoned work is reported (see
  `04-nondeterminism-and-replay.md`). Any other unexpected failure after
  actors start throws an `ExecutionError` carrying `abandonedWork`, so the CLI
  can still apply its termination boundary.
- **Abort listeners that throw crash the process.** An exception thrown by a
  listener on `context.signal` is reported by Node.js as an uncaught exception.

## 6. CLI behavior

- `--step-timeout MS` sets `stepTimeoutMs` for `test` and `replay`.
- Stalls are reported in text and JSON output. The JSON includes `haltReason`,
  `abandonedWork`, and `haltTrace` (the schedule that caused the halt). The
  text output lists that schedule's teardown entries. Stalled runs exit with status 1, invalid values with status 2.
- **Termination boundary.** When the engine reports abandoned work, the CLI:
  1. writes its full report (for `replay`, this includes diverged replays);
  2. prints a notice on stderr;
  3. waits for stdout and stderr to flush;
  4. ends the process with the exit status it had already determined.

  This is the only place the process is ended explicitly. Without it,
  abandoned work (for example a pending socket) could keep the CLI alive
  indefinitely. Runs without abandoned work exit naturally.

## 7. Trace fields and replay

These fields are optional additions to schema version 1. Traces without them
are unchanged.

- `outcome: 'stalled'` — new outcome value.
- `stall: { timeoutMs, afterDecisions, actors: [{ actor, lastCheckpoint, settledAfterAbort }] }`
  — present only for stalled runs.
- `teardown: [{ actor, status, detail }]` — present only when teardown problems occurred.

Replaying a stalled trace uses its recorded `timeoutMs` unless `stepTimeoutMs`
is passed explicitly. The replay matches if the same actors stall at the same
point, with the same last checkpoints. A diverged replay that ran to completion
includes the `observed` trace.

The optional `stepLimitReached` field, validation, and the classification of
replay divergence are covered in `04-nondeterminism-and-replay.md`.
