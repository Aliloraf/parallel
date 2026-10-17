import { clearTimeout, setImmediate, setTimeout } from 'node:timers';
import { SimulationCancelledError } from '../../sdk/src/index.ts';
import type { Actor, Scenario } from '../../sdk/src/index.ts';

export type Decision = { actor: string; checkpoint: string };
export type Outcome = 'passed' | 'invariant_failed' | 'actor_error' | 'incomplete' | 'stalled';
export type Violation = { name: string; detail: string };
export type StallReport = {
  /** Wall-clock budget that elapsed without the run reaching quiescence. */
  timeoutMs: number;
  /** Number of scheduling decisions made before the stall was detected. */
  afterDecisions: number;
  /**
   * Actors still executing when the budget elapsed. `settledAfterAbort` reports
   * whether the actor's task finished during teardown (e.g. by honoring
   * `context.signal`); if not, its work was abandoned, not cancelled.
   */
  actors: { actor: string; lastCheckpoint: string | null; settledAfterAbort: boolean }[];
};
export type TeardownEntry = {
  actor: string;
  /**
   * - `ignored-cancellation`: called `checkpoint()` again after cancellation; that call never settles.
   * - `cleanup-error`: threw a non-cancellation error while handling cancellation.
   * - `unresponsive`: its task did not settle within the teardown budget; its work was abandoned.
   *   A parked actor whose task has not settled is also unresponsive: it may still be running,
   *   e.g. if it raced the parked checkpoint against other work.
   */
  status: 'ignored-cancellation' | 'cleanup-error' | 'unresponsive';
  detail: string;
};
export type Trace = {
  schemaVersion: 1;
  scenario: string;
  decisions: Decision[];
  outcome: Outcome;
  violations: Violation[];
  errors: { actor: string; message: string }[];
  /** Present only when `outcome` is `stalled`. */
  stall?: StallReport;
  /** Present only when actors misbehaved while the run was being closed. */
  teardown?: TeardownEntry[];
};
export type RunResult = {
  trace: Trace;
  alternatives: Decision[][];
};
export type ExploreOptions = {
  maxSchedules?: number;
  maxSteps?: number;
  stopOnFailure?: boolean;
  /**
   * Wall-clock budget for each wait on actors between scheduling decisions,
   * and for teardown. A safety net for unmanaged asynchronous work; it is not
   * part of deterministic scheduling.
   */
  stepTimeoutMs?: number;
};
export type ExploreResult = {
  scenario: string;
  schedulesExplored: number;
  failures: Trace[];
  outcomes: Trace[];
  complete: boolean;
  limitReached: 'maxSchedules' | 'maxSteps' | null;
  /** Set when exploration stopped early because a run stalled or left work it could not settle. */
  haltReason: 'stalled' | 'abandoned_work' | null;
  /** True if some actor task may still be running in this process; the engine cannot cancel it. */
  abandonedWork: boolean;
};
export type ReplayOptions = {
  /** Defaults to the trace's recorded stall timeout, then to `DEFAULT_STEP_TIMEOUT_MS`. */
  stepTimeoutMs?: number;
};
/** `abandonedWork` is true if an actor task from the replayed run may still be running. */
export type ReplayResult =
  | { status: 'replayed'; trace: Trace; abandonedWork: boolean }
  | { status: 'replay_diverged'; reason: string; observed?: Trace; abandonedWork: boolean };

export const DEFAULT_STEP_TIMEOUT_MS = 10_000;
/** Largest delay `setTimeout` honors; larger values silently fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

class ReplayDiverged extends Error {
  /** Set after the diverged run has been closed. */
  abandonedWork = false;
}

function validateStepTimeout(stepTimeoutMs: number): number {
  if (!Number.isSafeInteger(stepTimeoutMs) || stepTimeoutMs <= 0 || stepTimeoutMs > MAX_TIMER_MS) {
    throw new Error(`stepTimeoutMs must be an integer between 1 and ${MAX_TIMER_MS} (milliseconds)`);
  }
  return stepTimeoutMs;
}

function validateOptions({ maxSchedules = 1000, maxSteps = 100, stopOnFailure = false, stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS }: ExploreOptions) {
  for (const [name, value] of Object.entries({ maxSchedules, maxSteps })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  return { maxSchedules, maxSteps, stopOnFailure, stepTimeoutMs: validateStepTimeout(stepTimeoutMs) };
}

/** True if the run that produced `trace` left actor work the engine could not settle. */
export function leavesAbandonedWork(trace: Trace): boolean {
  return (trace.stall?.actors.some((actor) => !actor.settledAfterAbort) ?? false)
    || (trace.teardown?.some((entry) => entry.status === 'unresponsive') ?? false);
}

/**
 * Lifecycle of one actor within one run:
 *
 *   running --checkpoint()--> waiting --resume--> running
 *   running --run() resolves--> completed      running --run() throws--> errored
 *   waiting --run() settles (un-awaited checkpoint)--> errored
 *   running --step budget elapses--> stalled   (abandoned; never resumed)
 *   waiting --run closes--> cancelling --> cancelled | parked
 *   cancelling | parked --task unsettled after teardown budget--> unresponsive
 */
type ActorStatus =
  | 'running' | 'waiting' | 'completed' | 'errored' | 'stalled'
  | 'cancelling' | 'cancelled' | 'parked' | 'unresponsive';

type ActorRecord = {
  readonly id: string;
  status: ActorStatus;
  /** Checkpoint the actor last resumed from; null before its first resume. */
  lastCheckpoint: string | null;
  pending?: { checkpoint: string; resume: () => void; reject: (reason: Error) => void };
  /** The actor's task (its `run()` promise) has settled. */
  settled: boolean;
  /** The actor has received its one cancellation rejection. */
  cancellationDelivered: boolean;
};

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * State and lifecycle of a single schedule execution. Detecting that an actor
 * stopped making progress is separate from cancelling it: the engine can only
 * deliver cancellation (a checkpoint rejection and an aborted signal) and stop
 * waiting. It cannot force unmanaged promises or synchronous code to stop.
 */
class Run<State> {
  readonly state: State;
  readonly records: ActorRecord[];
  readonly decisions: Decision[] = [];
  readonly errors: { actor: string; message: string }[] = [];
  readonly teardown: TeardownEntry[] = [];
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  /** No further scheduling; actors receive cancellation. */
  private closed = false;
  /** The trace has been produced; later actor activity is ignored. */
  private finalized = false;
  /** Actors whose task had not settled at finalization; the single source for abandonment reporting. */
  private readonly unsettledAtClose = new Set<string>();
  private readonly scenario: Scenario<State>;
  private readonly stepTimeoutMs: number;

  constructor(scenario: Scenario<State>, stepTimeoutMs: number) {
    this.scenario = scenario;
    this.stepTimeoutMs = stepTimeoutMs;
    this.state = scenario.createState();
    this.records = scenario.actors.map((actor) => ({
      id: actor.id, status: 'running', lastCheckpoint: null, settled: false, cancellationDelivered: false,
    }));
  }

  start(): void {
    this.scenario.actors.forEach((actor, i) => this.launch(actor, this.records[i]!));
  }

  /** Actors paused at a checkpoint, in stable scenario order. */
  eligible(): Decision[] {
    return this.records.filter((record) => record.status === 'waiting')
      .map((record) => ({ actor: record.id, checkpoint: record.pending!.checkpoint }));
  }

  resume(actorId: string): void {
    const record = this.records.find((candidate) => candidate.id === actorId)!;
    const pending = record.pending!;
    record.pending = undefined;
    record.status = 'running';
    record.lastCheckpoint = pending.checkpoint;
    this.decisions.push({ actor: actorId, checkpoint: pending.checkpoint });
    pending.resume();
  }

  /** Waits until no actor is running; false if the step budget elapsed first. */
  awaitQuiescence(): Promise<boolean> {
    return this.waitUntil(() => !this.records.some((record) => record.status === 'running'));
  }

  /** Marks every still-running actor as stalled and returns them. */
  markStalled(): ActorRecord[] {
    const stalled = this.records.filter((record) => record.status === 'running');
    for (const record of stalled) record.status = 'stalled';
    return stalled;
  }

  /**
   * Closes the run: aborts the signal, rejects paused actors with a cancellation
   * error, and waits (bounded) for every actor task to settle. Unsettled tasks
   * are reported (stalled actors in the stall report, others as `unresponsive`),
   * never awaited indefinitely.
   */
  async close(reason: string): Promise<void> {
    this.closed = true;
    const cancellation = new SimulationCancelledError(`Run closed: ${reason}`);
    this.controller.abort(cancellation);
    for (const record of this.records) {
      if (record.status !== 'waiting') continue;
      const pending = record.pending!;
      record.pending = undefined;
      record.status = 'cancelling';
      record.cancellationDelivered = true;
      pending.reject(cancellation);
    }
    await this.waitUntil(() => this.records.every((record) => record.settled));
    for (const record of this.records) {
      if (record.settled) continue;
      this.unsettledAtClose.add(record.id);
      if (record.status === 'stalled') continue;
      record.status = 'unresponsive';
      this.teardown.push({ actor: record.id, status: 'unresponsive', detail: `did not settle within ${this.stepTimeoutMs} ms after cancellation` });
    }
    this.finalized = true;
  }

  /** True if some actor task had not settled when the run was finalized. */
  leftUnsettledWork(): boolean {
    return this.unsettledAtClose.size > 0;
  }

  /** Whether the actor's task had settled when the run was finalized. */
  settledAtClose(record: ActorRecord): boolean {
    return !this.unsettledAtClose.has(record.id);
  }

  private launch(actor: Actor<State>, record: ActorRecord): void {
    const context = {
      state: this.state,
      signal: this.controller.signal,
      checkpoint: (name: string) => this.checkpoint(record, name),
    };
    void (async () => {
      try {
        await actor.run(context);
        this.settle(record, undefined);
      } catch (cause) {
        this.settle(record, cause instanceof Error ? cause : new Error(String(cause)));
      }
    })();
  }

  private checkpoint(record: ActorRecord, name: string): Promise<void> {
    if (this.closed) return this.checkpointAfterClose(record, name);
    if (!name.trim()) throw new Error(`Empty checkpoint name in ${record.id}`);
    if (record.status === 'waiting') throw new Error(`Actor ${record.id} reached overlapping checkpoints`);
    if (record.status !== 'running') {
      // A context that escaped its actor (e.g. stored in shared state) was used after the actor finished.
      const misuse = `Actor ${record.id} called checkpoint('${name}') after it finished`;
      this.errors.push({ actor: record.id, message: misuse });
      throw new Error(misuse);
    }
    return new Promise<void>((resume, reject) => {
      record.status = 'waiting';
      record.pending = { checkpoint: name, resume, reject };
      this.notify();
    });
  }

  /**
   * The first checkpoint an actor reaches after close receives the cancellation
   * error. Later calls mean the actor ignored it; such calls are parked on a
   * promise that never settles, so a retry loop can neither spin nor touch
   * scheduler state. Parking suspends only that call: the actor's task may
   * still be active, so teardown keeps waiting for the task itself.
   */
  private checkpointAfterClose(record: ActorRecord, name: string): Promise<void> {
    if (!record.cancellationDelivered) {
      record.cancellationDelivered = true;
      return Promise.reject(this.controller.signal.reason as Error);
    }
    if (record.status === 'cancelling' && !this.finalized) {
      record.status = 'parked';
      this.teardown.push({ actor: record.id, status: 'ignored-cancellation', detail: `called checkpoint('${name}') after cancellation and was suspended indefinitely` });
      this.notify();
    }
    return new Promise<void>(() => {});
  }

  private settle(record: ActorRecord, error: Error | undefined): void {
    record.settled = true;
    if (this.finalized) return;
    const pending = record.pending;
    record.pending = undefined;
    if (this.closed) {
      if (record.status === 'cancelling' || record.status === 'parked') {
        if (record.status === 'cancelling') record.status = 'cancelled';
        if (error && !(error instanceof SimulationCancelledError)) {
          this.teardown.push({ actor: record.id, status: 'cleanup-error', detail: error.message });
        }
      }
    } else if (error) {
      record.status = 'errored';
      this.errors.push({ actor: record.id, message: error.message });
    } else if (pending) {
      record.status = 'errored';
      this.errors.push({ actor: record.id, message: `Actor ${record.id} finished while checkpoint '${pending.checkpoint}' was still pending (missing await?)` });
    } else {
      record.status = 'completed';
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Waits until `done()` holds or `stepTimeoutMs` elapses. The ref'd timer keeps
   * the event loop alive, so an actor blocked on a promise that can never settle
   * is reported instead of letting the process exit as if nothing were pending.
   * Once `done()` holds, one macrotask turn lets queued microtasks run (e.g. an
   * actor returning right after an un-awaited checkpoint) before it is trusted.
   */
  private async waitUntil(done: () => boolean): Promise<boolean> {
    if (!done()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let wake = () => {};
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, this.stepTimeoutMs);
      });
      const listener = () => wake();
      this.listeners.add(listener);
      try {
        while (!done() && !timedOut) {
          await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), deadline]);
        }
      } finally {
        this.listeners.delete(listener);
        clearTimeout(timer);
      }
      if (!done()) return false;
    }
    await nextMacrotask();
    return true;
  }
}

/**
 * Executes one deterministic schedule of *explicit* asynchronous checkpoints.
 * Work between checkpoints is not interleaved; unmanaged awaits are tolerated
 * only within the step budget. Branch alternatives are recorded for subsequent
 * depth-first exploration.
 */
async function execute<State>(
  scenario: Scenario<State>,
  prefix: readonly Decision[],
  limits: { maxSteps: number; stepTimeoutMs: number },
  exactReplay = false,
): Promise<RunResult> {
  const run = new Run(scenario, limits.stepTimeoutMs);
  const alternatives: Decision[][] = [];
  const violations: Violation[] = [];
  let stalled: ActorRecord[] = [];
  let outcome: Outcome = 'passed';
  let closeReason = 'replay diverged';
  let thrown: { cause: unknown } | undefined;
  try {
    run.start();
    for (;;) {
      if (!(await run.awaitQuiescence())) {
        stalled = run.markStalled();
        outcome = 'stalled';
        break;
      }
      const eligible = run.eligible();
      if (eligible.length === 0) break;
      if (run.decisions.length >= limits.maxSteps) { outcome = 'incomplete'; break; }
      const step = run.decisions.length;
      const selected = step < prefix.length ? prefix[step]! : eligible[0]!;
      if (!eligible.some((option) => option.actor === selected.actor && option.checkpoint === selected.checkpoint)) {
        throw new ReplayDiverged(`Step ${step + 1}: actor/checkpoint ${selected.actor}:${selected.checkpoint} is not eligible`);
      }
      // Every unforced decision creates an unexplored sibling prefix.
      if (!exactReplay && step >= prefix.length) {
        for (const option of eligible.slice(1)) alternatives.push([...run.decisions, option]);
      }
      run.resume(selected.actor);
    }
    if (exactReplay && outcome !== 'stalled' && run.decisions.length !== prefix.length) {
      throw new ReplayDiverged(`Trace has ${prefix.length} decisions but scenario finished after ${run.decisions.length}`);
    }
    if (outcome === 'passed' && run.errors.length > 0) outcome = 'actor_error';
    if (outcome === 'passed') {
      for (const invariant of scenario.invariants) {
        try {
          if (!invariant.check(run.state)) {
            violations.push({ name: invariant.name, detail: invariant.describeFailure?.(run.state) ?? `Invariant "${invariant.name}" returned false` });
          }
        } catch (cause) {
          run.errors.push({ actor: '(invariant)', message: message(cause) });
          outcome = 'actor_error';
        }
      }
      if (outcome === 'passed' && violations.length > 0) outcome = 'invariant_failed';
    }
    closeReason = { passed: 'run finished', invariant_failed: 'run finished', actor_error: 'run finished', incomplete: 'step limit reached', stalled: 'actor stalled' }[outcome];
  } catch (cause) {
    thrown = { cause };
  }
  await run.close(closeReason);
  if (thrown) {
    if (thrown.cause instanceof ReplayDiverged) thrown.cause.abandonedWork = run.leftUnsettledWork();
    throw thrown.cause;
  }
  // Copies: abandoned actors must not be able to mutate a returned trace.
  const trace: Trace = {
    schemaVersion: 1, scenario: scenario.name, decisions: [...run.decisions], outcome, violations, errors: [...run.errors],
  };
  if (outcome === 'stalled') {
    trace.stall = {
      timeoutMs: limits.stepTimeoutMs,
      afterDecisions: run.decisions.length,
      actors: stalled.map((record) => ({ actor: record.id, lastCheckpoint: record.lastCheckpoint, settledAfterAbort: run.settledAtClose(record) })),
    };
  }
  if (run.teardown.length > 0) trace.teardown = [...run.teardown];
  return { trace, alternatives };
}

export async function explore<State>(scenario: Scenario<State>, options: ExploreOptions = {}): Promise<ExploreResult> {
  const { maxSchedules, maxSteps, stopOnFailure, stepTimeoutMs } = validateOptions(options);
  const pending: Decision[][] = [[]];
  const outcomes: Trace[] = [];
  const failures: Trace[] = [];
  let limitReached: ExploreResult['limitReached'] = null;
  let haltReason: ExploreResult['haltReason'] = null;
  let abandonedWork = false;
  while (pending.length > 0 && outcomes.length < maxSchedules) {
    const prefix = pending.pop()!;
    const result = await execute(scenario, prefix, { maxSteps, stepTimeoutMs });
    outcomes.push(result.trace);
    if (result.trace.outcome === 'incomplete') limitReached = 'maxSteps';
    if (result.trace.outcome === 'invariant_failed' || result.trace.outcome === 'actor_error' || result.trace.outcome === 'stalled') {
      failures.push(result.trace);
    }
    // LIFO depth-first traversal, reproducible with stable actor ordering.
    pending.push(...result.alternatives.reverse());
    // Never start another schedule while work from this one may still be running.
    abandonedWork = leavesAbandonedWork(result.trace);
    if (result.trace.outcome === 'stalled' || abandonedWork) {
      haltReason = result.trace.outcome === 'stalled' ? 'stalled' : 'abandoned_work';
      break;
    }
    if (stopOnFailure && failures.length > 0) break;
  }
  if (pending.length > 0 && limitReached === null && haltReason === null) limitReached = 'maxSchedules';
  return {
    scenario: scenario.name,
    schedulesExplored: outcomes.length,
    failures,
    outcomes,
    complete: pending.length === 0 && limitReached === null && haltReason === null,
    limitReached,
    haltReason,
    abandonedWork,
  };
}

function sameStall(observed: StallReport | undefined, recorded: StallReport | undefined): boolean {
  const key = (stall: StallReport | undefined) => stall && JSON.stringify({
    afterDecisions: stall.afterDecisions,
    actors: stall.actors.map(({ actor, lastCheckpoint }) => ({ actor, lastCheckpoint })),
  });
  return key(observed) === key(recorded);
}

export async function replay<State>(scenario: Scenario<State>, trace: Trace, options: ReplayOptions = {}): Promise<ReplayResult> {
  const stepTimeoutMs = validateStepTimeout(options.stepTimeoutMs ?? trace.stall?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
  if (trace.schemaVersion !== 1) return { status: 'replay_diverged', reason: 'Unsupported trace schema version', abandonedWork: false };
  if (trace.scenario !== scenario.name) return { status: 'replay_diverged', reason: 'Scenario name does not match trace', abandonedWork: false };
  try {
    const result = await execute(scenario, trace.decisions, { maxSteps: trace.decisions.length + 1, stepTimeoutMs }, true);
    if (result.trace.outcome !== trace.outcome
        || JSON.stringify(result.trace.violations) !== JSON.stringify(trace.violations)
        || !sameStall(result.trace.stall, trace.stall)) {
      return { status: 'replay_diverged', reason: 'Observed outcome differs from recorded trace', observed: result.trace, abandonedWork: leavesAbandonedWork(result.trace) };
    }
    return { status: 'replayed', trace: result.trace, abandonedWork: leavesAbandonedWork(result.trace) };
  } catch (cause) {
    if (cause instanceof ReplayDiverged) return { status: 'replay_diverged', reason: cause.message, abandonedWork: cause.abandonedWork };
    throw cause;
  }
}
