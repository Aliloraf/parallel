import type { Scenario } from '../../sdk/src/index.ts';

export type Decision = { actor: string; checkpoint: string };
export type Outcome = 'passed' | 'invariant_failed' | 'actor_error' | 'incomplete';
export type Violation = { name: string; detail: string };
export type Trace = {
  schemaVersion: 1;
  scenario: string;
  decisions: Decision[];
  outcome: Outcome;
  violations: Violation[];
  errors: { actor: string; message: string }[];
};
export type RunResult = {
  trace: Trace;
  alternatives: Decision[][];
};
export type ExploreOptions = {
  maxSchedules?: number;
  maxSteps?: number;
  stopOnFailure?: boolean;
};
export type ExploreResult = {
  scenario: string;
  schedulesExplored: number;
  failures: Trace[];
  outcomes: Trace[];
  complete: boolean;
  limitReached: 'maxSchedules' | 'maxSteps' | null;
};
export type ReplayResult =
  | { status: 'replayed'; trace: Trace }
  | { status: 'replay_diverged'; reason: string };

class ReplayDiverged extends Error {}
class Cancelled extends Error {}

function validateOptions({ maxSchedules = 1000, maxSteps = 100, stopOnFailure = false }: ExploreOptions) {
  for (const [name, value] of Object.entries({ maxSchedules, maxSteps })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  return { maxSchedules, maxSteps, stopOnFailure };
}

/**
 * Executes one deterministic schedule of *explicit* asynchronous checkpoints.
 * Actors must not use unmanaged awaits or external I/O between checkpoints.
 * Branch alternatives are recorded for subsequent depth-first exploration.
 */
async function execute<State>(
  scenario: Scenario<State>,
  prefix: readonly Decision[],
  maxSteps: number,
  exactReplay = false,
): Promise<RunResult> {
  const state = scenario.createState();
  const waiting = new Map<string, { checkpoint: string; resume: () => void; reject: (reason: Error) => void }>();
  const completed = new Set<string>();
  const errors: { actor: string; message: string }[] = [];
  const decisions: Decision[] = [];
  const alternatives: Decision[][] = [];
  let wake: (() => void) | undefined;
  const signal = () => { const resolve = wake; wake = undefined; resolve?.(); };
  const awaitChange = () => new Promise<void>((resolve) => { wake = resolve; });

  const tasks = scenario.actors.map((actor) => (async () => {
    try {
      await actor.run({
        state,
        checkpoint: (checkpoint: string) => {
          if (!checkpoint.trim()) throw new Error(`Empty checkpoint name in ${actor.id}`);
          if (waiting.has(actor.id)) throw new Error(`Actor ${actor.id} reached overlapping checkpoints`);
          return new Promise<void>((resume, reject) => {
            waiting.set(actor.id, { checkpoint, resume, reject });
            signal();
          });
        },
      });
    } catch (cause) {
      if (!(cause instanceof Cancelled)) {
        errors.push({ actor: actor.id, message: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      completed.add(actor.id);
      signal();
    }
  })());

  // Only explicitly controlled checkpoints are supported; uninstrumented promises
  // may prevent actors from becoming quiescent and are outside this prototype.
  const quiescent = async () => {
    while (waiting.size + completed.size !== scenario.actors.length) await awaitChange();
  };

  let outcome: Outcome = 'passed';
  try {
    await quiescent();
    while (waiting.size > 0) {
      if (decisions.length >= maxSteps) { outcome = 'incomplete'; break; }
      const eligible = scenario.actors.filter((actor) => waiting.has(actor.id)).map((actor) => {
        const checkpoint = waiting.get(actor.id)!.checkpoint;
        return { actor: actor.id, checkpoint };
      });
      const selected = decisions.length < prefix.length
        ? prefix[decisions.length]!
        : eligible[0]!;
      if (!eligible.some((option) => option.actor === selected.actor && option.checkpoint === selected.checkpoint)) {
        throw new ReplayDiverged(`Step ${decisions.length + 1}: actor/checkpoint ${selected.actor}:${selected.checkpoint} is not eligible`);
      }
      // Every unforced decision creates an unexplored sibling prefix.
      if (!exactReplay && decisions.length >= prefix.length) {
        for (const option of eligible.slice(1)) alternatives.push([...decisions, option]);
      }
      decisions.push(selected);
      const ticket = waiting.get(selected.actor)!;
      waiting.delete(selected.actor);
      ticket.resume();
      await quiescent();
    }
    if (exactReplay && decisions.length !== prefix.length) {
      throw new ReplayDiverged(`Trace has ${prefix.length} decisions but scenario finished after ${decisions.length}`);
    }
    if (outcome !== 'incomplete' && errors.length > 0) outcome = 'actor_error';
  } finally {
    // Don't leave suspended actor tasks around after a bounded run or divergence.
    for (const ticket of waiting.values()) ticket.reject(new Cancelled('run cancelled'));
    waiting.clear();
    await Promise.allSettled(tasks);
  }
  const violations: Violation[] = [];
  if (outcome === 'passed') {
    for (const invariant of scenario.invariants) {
      try {
        if (!invariant.check(state)) {
          violations.push({ name: invariant.name, detail: invariant.describeFailure?.(state) ?? `Invariant "${invariant.name}" returned false` });
        }
      } catch (cause) {
        errors.push({ actor: '(invariant)', message: cause instanceof Error ? cause.message : String(cause) });
        outcome = 'actor_error';
      }
    }
    if (outcome === 'passed' && violations.length > 0) outcome = 'invariant_failed';
  }
  return {
    trace: { schemaVersion: 1, scenario: scenario.name, decisions, outcome, violations, errors },
    alternatives,
  };
}

export async function explore<State>(scenario: Scenario<State>, options: ExploreOptions = {}): Promise<ExploreResult> {
  const { maxSchedules, maxSteps, stopOnFailure } = validateOptions(options);
  const pending: Decision[][] = [[]];
  const outcomes: Trace[] = [];
  const failures: Trace[] = [];
  let limitReached: ExploreResult['limitReached'] = null;
  while (pending.length > 0 && outcomes.length < maxSchedules) {
    const prefix = pending.pop()!;
    const result = await execute(scenario, prefix, maxSteps);
    outcomes.push(result.trace);
    if (result.trace.outcome === 'incomplete') limitReached = 'maxSteps';
    if (result.trace.outcome === 'invariant_failed' || result.trace.outcome === 'actor_error') {
      failures.push(result.trace);
    }
    // LIFO depth-first traversal, reproducible with stable actor ordering.
    pending.push(...result.alternatives.reverse());
    if (stopOnFailure && failures.length > 0) break;
  }
  if (pending.length > 0 && limitReached === null) limitReached = 'maxSchedules';
  return {
    scenario: scenario.name,
    schedulesExplored: outcomes.length,
    failures,
    outcomes,
    complete: pending.length === 0 && limitReached === null,
    limitReached,
  };
}

export async function replay<State>(scenario: Scenario<State>, trace: Trace): Promise<ReplayResult> {
  if (trace.schemaVersion !== 1) return { status: 'replay_diverged', reason: 'Unsupported trace schema version' };
  if (trace.scenario !== scenario.name) return { status: 'replay_diverged', reason: 'Scenario name does not match trace' };
  try {
    const result = await execute(scenario, trace.decisions, trace.decisions.length + 1, true);
    if (result.trace.outcome !== trace.outcome || JSON.stringify(result.trace.violations) !== JSON.stringify(trace.violations)) {
      return { status: 'replay_diverged', reason: 'Observed outcome differs from recorded trace' };
    }
    return { status: 'replayed', trace: result.trace };
  } catch (cause) {
    if (cause instanceof ReplayDiverged) return { status: 'replay_diverged', reason: cause.message };
    throw cause;
  }
}
