# Execution lifecycle, stalls and cancellation

This document describes how the engine runs a single schedule, how it detects actors that stop making progress, and what it can and cannot do about them. Deadlock detection is not implemented.

## Running a schedule

1. The engine creates fresh state and starts every actor's `run()`. Each actor executes until its first checkpoint, in declaration order, before any scheduling decision is made.
2. The scheduler waits until no actor is executing: each one is either paused at a checkpoint or finished. Before trusting that, it waits one more macrotask turn so that queued microtasks run. This catches, for example, an actor that returns right after an un-awaited checkpoint before the scheduler acts on that checkpoint.
3. The scheduler picks one paused actor, records the decision and resumes it. When re-running a recorded prefix it takes the recorded decision; otherwise it takes the first eligible actor in declaration order and remembers the alternatives for later schedules.
4. Steps 2 and 3 repeat until no actor is paused, `maxSteps` decisions have been made, or an actor stalls. Then the run is closed (see [Closing a run](#closing-a-run)).

## Actor states

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
| `running` | Executing code between checkpoints, or before its first checkpoint. |
| `waiting` | Paused at a checkpoint and eligible to be scheduled. |
| `completed`, `errored` | `run()` resolved or threw. Finishing while a checkpoint is still pending is an error ("missing await?"). |
| `stalled` | Still `running` when the step budget ran out. |
| `cancelling` | Was paused when the run closed and has been sent cancellation. |
| `cancelled` | Settled after cancellation. |
| `parked` | Called `checkpoint()` again after cancellation. That call never settles, but the actor's task may still be running. |
| `unresponsive` | A `cancelling` or `parked` actor whose task had not settled when the teardown budget ran out. |

These checkpoint mistakes are reported as `actor_error`: an empty checkpoint name, two pending checkpoints in one actor, an un-awaited checkpoint the actor never comes back to, and calling `checkpoint()` through a context after its actor has finished.

## Stall detection

Every wait in step 2 is limited by `stepTimeoutMs` (CLI: `--step-timeout`), 10,000 ms by default. The value must be an integer from 1 to 2,147,483,647, the largest delay `setTimeout` accepts; anything else is rejected.

If the budget runs out while an actor is still `running`, that actor is `stalled` and so is the schedule. A stalled schedule counts as a failure, and exploration stops immediately with `haltReason: 'stalled'` and `complete: false`, so no new schedule starts while the stalled work may still be running.

The timer also keeps Node.js's event loop alive. Without it, an actor waiting on a promise that can never settle would let the process exit with status 0 and no output.

The timeout is a safety net, not part of deterministic scheduling: whether a slow actor counts as stalled depends on machine speed and load.

## Closing a run

Every run is closed when it ends, whatever the reason:

1. Scheduling stops and the run is fenced off: later activity from its actors can no longer change scheduler state, the returned trace, or a later run.
2. `context.signal` is aborted with a `SimulationCancelledError` as its reason.
3. Pending checkpoints reject with `SimulationCancelledError`. A stalled actor that reaches a checkpoint later gets the same error. Any `checkpoint()` call after that is parked and never settles, so a retry loop can neither spin nor hold up teardown.
4. The engine waits, again for at most `stepTimeoutMs`, for every actor's task (the promise returned by `run()`) to settle. Whether each task settled is recorded once, when the run is finalized; the stall report, the teardown entries and `abandonedWork` all come from that record.

Parking suspends a single checkpoint call, not necessarily the actor. An actor that raced the parked call against other work, for example with `Promise.race`, keeps running, so a parked actor whose task hasn't settled also counts as abandoned work.

Problems during teardown are recorded in the trace's optional `teardown` field without changing the run's outcome:

| `status` | Meaning |
|---|---|
| `ignored-cancellation` | The actor called `checkpoint()` again after cancellation, and that call was parked. If the task then doesn't settle, an `unresponsive` entry follows. |
| `cleanup-error` | The actor threw an error other than `SimulationCancelledError` while handling cancellation. |
| `unresponsive` | The actor's task didn't settle within the teardown budget. Its work is abandoned and exploration stops with `haltReason: 'abandoned_work'`. |

An actor that stalls and then ignores the abort signal uses the budget twice, once to be detected and once during teardown, so the worst case is about twice `stepTimeoutMs`.

## Detection is not cancellation

The engine can tell that an actor stopped making progress, but it cannot stop what the actor is doing. JavaScript has no way to force an arbitrary promise, timer, socket or synchronous loop to end. Cancellation is cooperative:

- Actors can pass `context.signal` to APIs that accept an `AbortSignal` (`fetch(url, { signal })`), or listen to it themselves.
- Their next checkpoint rejects with `SimulationCancelledError`.

Work that doesn't cooperate is abandoned. It keeps running in the background, may keep handles open, and may change anything outside the state created by `createState()`. The engine reports it:

- `ExploreResult.abandonedWork` is `true`, and `replay()` reports the same flag on every result, including diverged replays.
- In the trace, the stalled actor has `settledAfterAbort: false`, or a teardown entry has status `unresponsive`. `leavesAbandonedWork(trace)` checks a single trace.

Exploration never starts another schedule while an actor's task from an earlier schedule is unsettled. That guarantee covers each actor's `run()` task only. Work an actor detaches from it, such as an un-awaited promise or a `setInterval`, is invisible to the engine, even after the actor completes.

Some problems can't be detected from inside the process:

- A synchronous infinite loop, or an endless chain of microtasks, blocks the event loop and with it the stall timer. Detecting these requires running actors in a separate thread or process, which is on the [roadmap](01-parallel.md#roadmap).
- An un-awaited checkpoint followed by more asynchronous work looks like a paused actor. It is only caught if the actor finishes before the scheduler acts.

Other limitations:

- The engine can't tell an actor frozen on a parked checkpoint from one that is still active, so any actor that ignores cancellation costs the full teardown budget and stops exploration unless its task settles in time.
- Runs that end because of nondeterminism or replay divergence are closed in the same way, and their abandoned work is reported ([nondeterminism and replay](04-nondeterminism-and-replay.md)). Any other unexpected engine failure after actors have started throws an `ExecutionError` that carries `abandonedWork`.
- An exception thrown by a listener on `context.signal` is treated by Node.js as an uncaught exception and crashes the process.

## CLI behavior

`--step-timeout MS` sets `stepTimeoutMs` for both `test` and `replay`. Stalls are shown in the text and JSON output; the JSON also has `haltReason`, `abandonedWork` and `haltTrace` (the schedule that caused the halt), and the text output lists that schedule's teardown entries. A stalled exploration exits with status 1; an invalid `--step-timeout` with status 2. An error that escapes from scenario code outside an actor's `run()` (a throwing timer callback, an unhandled rejection, a throwing abort listener) ends the CLI with a runtime error, exit status 5.

When the engine reports abandoned work, the CLI writes its full report (also for diverged replays), prints a notice on stderr, waits for both output streams to flush, and then exits with the status it had already determined. This is the only place where the CLI ends the process explicitly; otherwise abandoned work such as a pending socket could keep it alive indefinitely. Runs without abandoned work exit normally.

## Trace fields

Schema version 1 traces can carry these optional fields; traces of runs without stalls or teardown problems don't contain them:

- `outcome: 'stalled'`.
- `stall: { timeoutMs, afterDecisions, actors: [{ actor, lastCheckpoint, settledAfterAbort }] }`, only for stalled runs.
- `teardown: [{ actor, status, detail }]`, only when teardown problems occurred.

Replaying a stalled trace uses its recorded `timeoutMs` unless `stepTimeoutMs` is passed explicitly. The replay matches if the same actors stall after the same number of decisions, with the same last checkpoints. The `stepLimitReached` field, trace validation and replay divergence are covered in [nondeterminism and replay](04-nondeterminism-and-replay.md).
