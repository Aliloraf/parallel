/** API surface for fully instrumented, cooperative scenarios. */
export type StepContext<State> = {
  /** Scenario-local shared state, recreated before every schedule. */
  readonly state: State;
  /** Pauses this actor until the scheduler selects it. */
  checkpoint(name: string): Promise<void>;
};

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
