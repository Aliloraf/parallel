/** API surface for fully instrumented, cooperative scenarios. */
export type StepContext<State> = {
  /** Scenario-local shared state, recreated before every schedule. */
  readonly state: State;
  /**
   * Pauses this actor until the scheduler selects it. Rejects with
   * `SimulationCancelledError` once the run has been closed.
   */
  checkpoint(name: string): Promise<void>;
  /**
   * Aborted, with a `SimulationCancelledError` reason, when the run is closed:
   * after it finishes, hits a bound, diverges, or stalls. Pass it to cancellable
   * APIs (e.g. `fetch(url, { signal })`) so unmanaged work can stop cooperatively.
   * The engine cannot force arbitrary promises or synchronous code to stop.
   */
  readonly signal: AbortSignal;
};

/** Delivered to actors whose run is closed while they are paused or still active. */
export class SimulationCancelledError extends Error {
  override name = 'SimulationCancelledError';
}

/** The result of one `attempt`: the operation's value, or an error it was expected to throw. */
export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };

/**
 * Runs application code that may legitimately reject and turns an *expected*
 * rejection into data, so that the schedule keeps a normal outcome and its
 * invariants are still checked. An error that escapes an actor makes the whole
 * schedule an `actor_error`, and the engine then evaluates no invariants for
 * it, hiding whatever the scenario was built to detect.
 *
 * ```ts
 * const result = await attempt(() => sell(state.store, sku, checkpoint), (error) => error instanceof OutOfStock);
 * state.results.push(result);
 * ```
 *
 * Three rejections are never captured, so that a failure can never be mistaken
 * for an expected application outcome:
 *
 * - `SimulationCancelledError`, always, and without consulting `isExpected`.
 *   The engine's cancellation and teardown contract depends on it reaching the
 *   actor, so a predicate cannot opt out of it.
 * - A thrown value that is not an `Error`. It cannot be classified, and
 *   wrapping it would lose its identity, so it is rethrown exactly as thrown.
 * - Anything `isExpected` returns `false` for, rethrown as the same instance.
 *
 * `isExpected` is called at most once, only for a non-cancellation `Error`. If
 * it throws, that failure propagates instead of being reported as an expected
 * application result.
 */
export async function attempt<T>(operation: () => Promise<T>, isExpected: (error: Error) => boolean): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (cause) {
    if (cause instanceof SimulationCancelledError || !(cause instanceof Error)) throw cause;
    if (!isExpected(cause)) throw cause;
    return { ok: false, error: cause };
  }
}

export type Actor<State> = {
  readonly id: string;
  readonly run: (context: StepContext<State>) => Promise<void> | void;
};

export type Invariant<State> = {
  readonly name: string;
  readonly check: (state: State) => boolean;
  readonly describeFailure?: (state: State) => string;
};

export type Scenario<State> = {
  readonly name: string;
  readonly createState: () => State;
  readonly actors: readonly Actor<State>[];
  readonly invariants: readonly Invariant<State>[];
};

export function defineScenario<State>(scenario: Scenario<State>): Scenario<State> {
  if (!scenario.name.trim()) throw new Error('Scenario name cannot be empty');
  if (scenario.actors.length < 2) throw new Error('Scenario must define at least two actors');
  const ids = scenario.actors.map((actor) => actor.id);
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('Actor IDs must be nonempty and unique');
  }
  if (scenario.invariants.length === 0) throw new Error('Scenario requires at least one invariant');
  const invariantNames = scenario.invariants.map((invariant) => invariant.name);
  if (invariantNames.some((name) => !name.trim()) || new Set(invariantNames).size !== invariantNames.length) {
    throw new Error('Invariant names must be nonempty and unique');
  }
  return scenario;
}
