import { clearTimeout, setImmediate, setTimeout } from 'node:timers';
import { SimulationCancelledError } from '@aliloraf/parallel-sdk';
import type { Actor, Scenario } from '@aliloraf/parallel-sdk';
import { ROOT_BRANCH, branchAt, choicePoint, sameChoices } from './history.ts';
import type { Branch, ChoicePoint } from './history.ts';

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
  /**
   * Present only when the run stopped at the `maxSteps` bound while actors were
   * still eligible. The outcome is then `incomplete`, or `actor_error` if an
   * actor failed before the bound. Traces recorded before this field existed
   * omit it; for them, outcome `incomplete` implies the bound.
   */
  stepLimitReached?: true;
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
  /**
   * Set when exploration stopped before every schedule within the bounds was
   * explored for a reason other than a bound: a run stalled, left work it
   * could not settle, re-executed nondeterministically, or `stopOnFailure`.
   */
  haltReason: 'stalled' | 'abandoned_work' | 'nondeterministic' | 'stop_on_failure' | null;
  /** True if some actor task may still be running in this process; the engine cannot cancel it. */
  abandonedWork: boolean;
  /** Set when `haltReason` is `nondeterministic`. */
  nondeterminism: NondeterminismReport | null;
};
/**
 * Re-executing a recorded schedule prefix observed a different choice point
 * than the run that recorded it. Detection is limited to the eligible actors
 * and checkpoints at forced scheduling steps; it cannot prove a scenario
 * deterministic.
 */
export type NondeterminismReport = {
  /** Number of decisions made before the differing choice point. */
  afterDecisions: number;
  /** The forced prefix the run was re-executing. */
  prefix: Decision[];
  /** Decisions actually made before the difference was observed. */
  decisions: Decision[];
  /** Eligible decisions recorded at this step by the run that produced the prefix. */
  expected: Decision[];
  /** Eligible decisions observed on re-execution (empty if none). */
  observed: Decision[];
  /** Present only when actors misbehaved while the diverged run was being closed. */
  teardown?: TeardownEntry[];
  /** True if an actor task from the diverged run may still be running. */
  abandonedWork: boolean;
};
/** Machine-readable reason a replay could not reproduce a trace. */
export type ReplayDivergence =
  | { kind: 'unsupported_schema'; schemaVersion: number }
  | { kind: 'scenario_mismatch'; expected: string; observed: string }
  | { kind: 'decision_not_eligible'; afterDecisions: number; expected: Decision; eligible: Decision[] }
  /** The scenario finished after `afterDecisions` decisions, but the trace expects it to continue. */
  | { kind: 'ended_early'; afterDecisions: number }
  /** The trace finished naturally after `afterDecisions` decisions, but the scenario still had eligible actors. */
  | { kind: 'continued'; afterDecisions: number; eligible: Decision[] }
  | { kind: 'result_mismatch'; fields: ('outcome' | 'violations' | 'errors' | 'stall')[] };
export type ReplayOptions = {
  /** Defaults to the trace's recorded stall timeout, then to `DEFAULT_STEP_TIMEOUT_MS`. */
  stepTimeoutMs?: number;
};
/** `abandonedWork` is true if an actor task from the replayed run may still be running. */
export type ReplayResult =
  | { status: 'replayed'; trace: Trace; abandonedWork: boolean }
  | { status: 'replay_diverged'; reason: string; divergence: ReplayDivergence; observed?: Trace; abandonedWork: boolean };

export const DEFAULT_STEP_TIMEOUT_MS = 10_000;
/** Largest delay `setTimeout` honors; larger values silently fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Thrown when a value is not a structurally valid schema-version-1 trace. */
export class InvalidTraceError extends Error {
  override name = 'InvalidTraceError';
  constructor(detail: string) {
    super(`Invalid trace: ${detail}`);
  }
}

/**
 * Thrown when the engine itself fails after a run's actors have started. The
 * run was still closed with bounded teardown; `abandonedWork` reports whether
 * actor tasks from it may still be running.
 */
export class ExecutionError extends Error {
  override name = 'ExecutionError';
  readonly abandonedWork: boolean;
  constructor(cause: unknown, abandonedWork: boolean) {
    super(`Engine failure during execution: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.abandonedWork = abandonedWork;
  }
}

const OUTCOMES: readonly Outcome[] = ['passed', 'invariant_failed', 'actor_error', 'incomplete', 'stalled'];
const TEARDOWN_STATUSES: readonly TeardownEntry['status'][] = ['ignored-cancellation', 'cleanup-error', 'unresponsive'];

function invalid(detail: string): never {
  throw new InvalidTraceError(detail);
}
function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  return value;
}
function stringAt(value: unknown, path: string, nonEmpty = false): void {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) invalid(`${path} must be a ${nonEmpty ? 'non-empty ' : ''}string`);
}

/**
 * Checks that `value` is a structurally valid schema-version-1 trace and
 * returns it unchanged. Unknown extra fields are ignored. Missing optional
 * fields are never filled in: a trace recorded before a field existed is
 * accepted as it is. Throws `InvalidTraceError` naming the first invalid field.
 */
export function validateTrace(value: unknown): Trace {
  const trace = objectAt(value, 'trace');
  const { schemaVersion, outcome } = trace;
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) invalid('schemaVersion must be a positive integer');
  if (schemaVersion !== 1) invalid(`schemaVersion ${schemaVersion} is not supported (expected 1)`);
  stringAt(trace.scenario, 'scenario', true);
  const decisions = arrayAt(trace.decisions, 'decisions');
  decisions.forEach((entry, i) => {
    const decision = objectAt(entry, `decisions[${i}]`);
    stringAt(decision.actor, `decisions[${i}].actor`, true);
    stringAt(decision.checkpoint, `decisions[${i}].checkpoint`, true);
  });
  if (!OUTCOMES.includes(outcome as Outcome)) invalid(`outcome must be one of ${OUTCOMES.join(', ')}`);
  arrayAt(trace.violations, 'violations').forEach((entry, i) => {
    const violation = objectAt(entry, `violations[${i}]`);
    stringAt(violation.name, `violations[${i}].name`);
    stringAt(violation.detail, `violations[${i}].detail`);
  });
  arrayAt(trace.errors, 'errors').forEach((entry, i) => {
    const error = objectAt(entry, `errors[${i}]`);
    stringAt(error.actor, `errors[${i}].actor`);
    stringAt(error.message, `errors[${i}].message`);
  });
  if (trace.stall === undefined) {
    if (outcome === 'stalled') invalid('stall is required when outcome is "stalled"');
  } else {
    if (outcome !== 'stalled') invalid('stall is only allowed when outcome is "stalled"');
    const stall = objectAt(trace.stall, 'stall');
    if (typeof stall.timeoutMs !== 'number' || !Number.isSafeInteger(stall.timeoutMs) || stall.timeoutMs <= 0 || stall.timeoutMs > MAX_TIMER_MS) {
      invalid(`stall.timeoutMs must be an integer between 1 and ${MAX_TIMER_MS}`);
    }
    if (stall.afterDecisions !== decisions.length) invalid('stall.afterDecisions must equal the number of decisions');
    arrayAt(stall.actors, 'stall.actors').forEach((entry, i) => {
      const actor = objectAt(entry, `stall.actors[${i}]`);
      stringAt(actor.actor, `stall.actors[${i}].actor`, true);
      if (actor.lastCheckpoint !== null && typeof actor.lastCheckpoint !== 'string') invalid(`stall.actors[${i}].lastCheckpoint must be a string or null`);
      if (typeof actor.settledAfterAbort !== 'boolean') invalid(`stall.actors[${i}].settledAfterAbort must be a boolean`);
    });
  }
  if (trace.teardown !== undefined) {
    arrayAt(trace.teardown, 'teardown').forEach((entry, i) => {
      const teardown = objectAt(entry, `teardown[${i}]`);
      stringAt(teardown.actor, `teardown[${i}].actor`, true);
      if (!TEARDOWN_STATUSES.includes(teardown.status as TeardownEntry['status'])) invalid(`teardown[${i}].status must be one of ${TEARDOWN_STATUSES.join(', ')}`);
      stringAt(teardown.detail, `teardown[${i}].detail`);
    });
  }
  if (trace.stepLimitReached !== undefined) {
    if (trace.stepLimitReached !== true) invalid('stepLimitReached must be true when present');
    if (outcome !== 'incomplete' && outcome !== 'actor_error') invalid('stepLimitReached is only allowed when outcome is "incomplete" or "actor_error"');
  }
  return value as Trace;
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

/** How a run's forced prefix is checked at each forced step. */
type Forced =
  /** Exploration: the choice point at each forced step must equal the one recorded when the branch was created. */
  | { mode: 'explore'; branch: Branch }
  /** Replay: each recorded decision must be eligible; traces do not record choice points. */
  | { mode: 'replay'; prefix: readonly Decision[] };

type StepDivergence =
  | { kind: 'choices_changed'; afterDecisions: number; expected: Decision[]; observed: Decision[] }
  | { kind: 'decision_not_eligible'; afterDecisions: number; expected: Decision; eligible: Decision[] }
  | { kind: 'ended_early'; afterDecisions: number };

type Execution =
  | {
    kind: 'completed';
    trace: Trace;
    /** Unexplored sibling branches (exploration only). */
    branches: Branch[];
    /** Eligible decisions left when the step bound stopped the run; empty otherwise. */
    remaining: Decision[];
  }
  | { kind: 'diverged'; divergence: StepDivergence; decisions: Decision[]; teardown: TeardownEntry[]; abandonedWork: boolean };

const copyDecision = ({ actor, checkpoint }: Decision): Decision => ({ actor, checkpoint });
const sameDecision = (a: Decision, b: Decision) => a.actor === b.actor && a.checkpoint === b.checkpoint;

function checkForcedStep(forced: Forced, step: number, eligible: Decision[]): StepDivergence | undefined {
  if (forced.mode === 'explore') {
    const expected = forced.branch.expected[step]!;
    if (sameChoices(expected, eligible)) return undefined;
    return { kind: 'choices_changed', afterDecisions: step, expected: expected.map(copyDecision), observed: eligible };
  }
  const wanted = forced.prefix[step]!;
  if (eligible.length === 0) return { kind: 'ended_early', afterDecisions: step };
  if (!eligible.some((option) => sameDecision(option, wanted))) {
    return { kind: 'decision_not_eligible', afterDecisions: step, expected: copyDecision(wanted), eligible };
  }
  return undefined;
}

/**
 * Executes one deterministic schedule of *explicit* asynchronous checkpoints.
 * Work between checkpoints is not interleaved; unmanaged awaits are tolerated
 * only within the step budget. Every path, including divergence and engine
 * failure, closes the run with bounded teardown and measures abandoned work.
 */
async function execute<State>(
  scenario: Scenario<State>,
  forced: Forced,
  limits: { maxSteps: number; stepTimeoutMs: number },
): Promise<Execution> {
  const prefix = forced.mode === 'explore' ? forced.branch.prefix : forced.prefix;
  const run = new Run(scenario, limits.stepTimeoutMs);
  const branches: Branch[] = [];
  const choices: ChoicePoint[] = [];
  const violations: Violation[] = [];
  let stalled: ActorRecord[] = [];
  let outcome: Outcome = 'passed';
  let stepLimitReached = false;
  let remaining: Decision[] = [];
  let divergence: StepDivergence | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    run.start();
    for (;;) {
      if (!(await run.awaitQuiescence())) {
        stalled = run.markStalled();
        outcome = 'stalled';
        break;
      }
      const eligible = run.eligible();
      const step = run.decisions.length;
      // Forced steps are checked before anything else, so a run that diverges
      // or ends early inside its prefix is never reported as a shorter schedule.
      if (step < prefix.length) {
        divergence = checkForcedStep(forced, step, eligible);
        if (divergence) break;
      } else if (eligible.length === 0) {
        break;
      } else if (step >= limits.maxSteps) {
        stepLimitReached = true;
        remaining = eligible;
        break;
      }
      const point = choicePoint(eligible);
      choices.push(point);
      const selected = step < prefix.length ? prefix[step]! : point[0]!;
      // Every unforced decision creates an unexplored sibling branch.
      if (forced.mode === 'explore' && step >= prefix.length) {
        for (const option of point.slice(1)) branches.push(branchAt(run.decisions, choices, option));
      }
      run.resume(selected.actor);
    }
    if (!divergence && outcome !== 'stalled') {
      // An actor error is a detected failure even when the step bound also stopped the run.
      if (run.errors.length > 0) outcome = 'actor_error';
      else if (stepLimitReached) outcome = 'incomplete';
      else {
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
    }
  } catch (cause) {
    failure = { cause };
  }
  const closeReason = failure ? 'engine failure'
    : divergence ? (forced.mode === 'explore' ? 'nondeterministic re-execution' : 'replay diverged')
    : outcome === 'stalled' ? 'actor stalled'
    : stepLimitReached ? 'step limit reached'
    : 'run finished';
  await run.close(closeReason);
  if (failure) throw new ExecutionError(failure.cause, run.leftUnsettledWork());
  // Copies: abandoned actors and callers must not be able to mutate engine history or each other's results.
  const decisions = run.decisions.map(copyDecision);
  if (divergence) {
    return { kind: 'diverged', divergence, decisions, teardown: [...run.teardown], abandonedWork: run.leftUnsettledWork() };
  }
  const trace: Trace = {
    schemaVersion: 1, scenario: scenario.name, decisions, outcome, violations, errors: [...run.errors],
  };
  if (outcome === 'stalled') {
    trace.stall = {
      timeoutMs: limits.stepTimeoutMs,
      afterDecisions: run.decisions.length,
      actors: stalled.map((record) => ({ actor: record.id, lastCheckpoint: record.lastCheckpoint, settledAfterAbort: run.settledAtClose(record) })),
    };
  }
  if (run.teardown.length > 0) trace.teardown = [...run.teardown];
  if (stepLimitReached) trace.stepLimitReached = true;
  return { kind: 'completed', trace, branches, remaining };
}

export async function explore<State>(scenario: Scenario<State>, options: ExploreOptions = {}): Promise<ExploreResult> {
  const { maxSchedules, maxSteps, stopOnFailure, stepTimeoutMs } = validateOptions(options);
  const pending: Branch[] = [ROOT_BRANCH];
  const outcomes: Trace[] = [];
  const failures: Trace[] = [];
  let limitReached: ExploreResult['limitReached'] = null;
  let haltReason: ExploreResult['haltReason'] = null;
  let abandonedWork = false;
  let nondeterminism: NondeterminismReport | null = null;
  while (pending.length > 0 && outcomes.length < maxSchedules) {
    const branch = pending.pop()!;
    const result = await execute(scenario, { mode: 'explore', branch }, { maxSteps, stepTimeoutMs });
    if (result.kind === 'diverged') {
      const { divergence } = result;
      if (divergence.kind !== 'choices_changed') throw new Error(`Unexpected exploration divergence: ${divergence.kind}`);
      // Results already collected stay valid observations; the exploration as a whole cannot be trusted to be complete.
      nondeterminism = {
        afterDecisions: divergence.afterDecisions,
        prefix: branch.prefix.map(copyDecision),
        decisions: result.decisions,
        expected: divergence.expected,
        observed: divergence.observed,
        ...(result.teardown.length > 0 ? { teardown: result.teardown } : {}),
        abandonedWork: result.abandonedWork,
      };
      abandonedWork = result.abandonedWork;
      haltReason = 'nondeterministic';
      break;
    }
    const { trace } = result;
    outcomes.push(trace);
    if (trace.stepLimitReached) limitReached = 'maxSteps';
    if (trace.outcome === 'invariant_failed' || trace.outcome === 'actor_error' || trace.outcome === 'stalled') {
      failures.push(trace);
    }
    // LIFO depth-first traversal, reproducible with stable actor ordering.
    pending.push(...result.branches.reverse());
    // Never start another schedule while work from this one may still be running.
    abandonedWork = leavesAbandonedWork(trace);
    if (trace.outcome === 'stalled' || abandonedWork) {
      haltReason = trace.outcome === 'stalled' ? 'stalled' : 'abandoned_work';
      break;
    }
    if (stopOnFailure && failures.length > 0 && pending.length > 0) {
      haltReason = 'stop_on_failure';
      break;
    }
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
    nondeterminism,
  };
}

function sameStall(observed: StallReport | undefined, recorded: StallReport | undefined): boolean {
  const key = (stall: StallReport | undefined) => stall && JSON.stringify({
    afterDecisions: stall.afterDecisions,
    actors: stall.actors.map(({ actor, lastCheckpoint }) => ({ actor, lastCheckpoint })),
  });
  return key(observed) === key(recorded);
}

function describeDivergence(divergence: ReplayDivergence): string {
  switch (divergence.kind) {
    case 'unsupported_schema': return `Unsupported trace schema version ${divergence.schemaVersion}`;
    case 'scenario_mismatch': return `Trace is for scenario "${divergence.expected}", not "${divergence.observed}"`;
    case 'decision_not_eligible': return `Step ${divergence.afterDecisions + 1}: actor/checkpoint ${divergence.expected.actor}:${divergence.expected.checkpoint} is not eligible`;
    case 'ended_early': return `Scenario finished after ${divergence.afterDecisions} decision(s), but the trace expects it to continue`;
    case 'continued': return `Scenario still had eligible actors after the trace's ${divergence.afterDecisions} decision(s)`;
    case 'result_mismatch': return `Observed ${divergence.fields.join(', ')} differ from the recorded trace`;
  }
}

function diverged(divergence: ReplayDivergence, abandonedWork: boolean, observed?: Trace): ReplayResult {
  return { status: 'replay_diverged', reason: describeDivergence(divergence), divergence, ...(observed ? { observed } : {}), abandonedWork };
}

/**
 * Replays a recorded trace. The trace is validated structurally first
 * (`InvalidTraceError`). Exactly the recorded number of decisions is executed;
 * the step bound is respected for traces that recorded it.
 */
export async function replay<State>(scenario: Scenario<State>, trace: Trace, options: ReplayOptions = {}): Promise<ReplayResult> {
  const version: unknown = typeof trace === 'object' && trace !== null ? (trace as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > 1) {
    return diverged({ kind: 'unsupported_schema', schemaVersion: version }, false);
  }
  validateTrace(trace);
  const stepTimeoutMs = validateStepTimeout(options.stepTimeoutMs ?? trace.stall?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
  if (trace.scenario !== scenario.name) {
    return diverged({ kind: 'scenario_mismatch', expected: trace.scenario, observed: scenario.name }, false);
  }
  const length = trace.decisions.length;
  const result = await execute(scenario, { mode: 'replay', prefix: trace.decisions }, { maxSteps: length, stepTimeoutMs });
  if (result.kind === 'diverged') {
    const { divergence } = result;
    if (divergence.kind === 'choices_changed') throw new Error('Unexpected replay divergence: choices_changed');
    return diverged(divergence, result.abandonedWork);
  }
  const observed = result.trace;
  const abandonedWork = leavesAbandonedWork(observed);
  if (observed.outcome !== 'stalled') {
    // Traces recorded before `stepLimitReached` existed imply the bound only through outcome `incomplete`.
    const expectedBound = trace.stepLimitReached === true || trace.outcome === 'incomplete';
    const observedBound = observed.stepLimitReached === true;
    if (observedBound && !expectedBound) return diverged({ kind: 'continued', afterDecisions: length, eligible: result.remaining }, abandonedWork, observed);
    if (!observedBound && expectedBound) return diverged({ kind: 'ended_early', afterDecisions: length }, abandonedWork, observed);
  }
  const fields: ('outcome' | 'violations' | 'errors' | 'stall')[] = [];
  if (observed.outcome !== trace.outcome) fields.push('outcome');
  if (JSON.stringify(observed.violations) !== JSON.stringify(trace.violations)) fields.push('violations');
  if (JSON.stringify(observed.errors) !== JSON.stringify(trace.errors)) fields.push('errors');
  if (!sameStall(observed.stall, trace.stall)) fields.push('stall');
  if (fields.length > 0) return diverged({ kind: 'result_mismatch', fields }, abandonedWork, observed);
  return { status: 'replayed', trace: observed, abandonedWork };
}
