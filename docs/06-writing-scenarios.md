# Writing scenarios

A scenario describes a small concurrent situation that Parallel can run over and over in different orders: some shared state, two or more actors working on it, and the invariants that must hold when they're done.

## The parts of a scenario

```ts
import { defineScenario } from '@aliloraf/parallel-sdk';

export default defineScenario<{ count: number }>({
  name: 'counter',                      // appears in output and in traces
  createState: () => ({ count: 0 }),    // called again for every schedule
  actors: [/* at least two, with unique ids */],
  invariants: [/* at least one, with unique names */],
});
```

`defineScenario` checks these rules and throws if a scenario breaks one. Each actor is `{ id, run }`, where `run` receives a context with three members:

- `state`: the object returned by `createState` for the current schedule, shared by all actors.
- `checkpoint(name)`: pauses the actor until the scheduler lets it continue. Always `await` it.
- `signal`: an `AbortSignal` that is aborted when the run ends. See [asynchronous work](#asynchronous-work-between-checkpoints).

The CLI loads the module's default export, or a named `scenario` export.

## Choosing checkpoints

A checkpoint is a point where another actor may run. Parallel interleaves checkpoints and nothing else, so where you put them decides which races it can find.

Put a checkpoint between a read of shared state and the write that depends on it. That's where check-then-act and lost-update bugs live:

```ts
async run({ state, checkpoint }) {
  await checkpoint('read');
  const seen = state.count;
  await checkpoint('write');   // another actor may change count here
  state.count = seen + 1;
}
```

Code between two checkpoints runs as one indivisible step. That is a modeling decision: if two lines can't actually be interleaved in your system (because they run in one transaction or under a lock), keeping them in one step is accurate. If they can, a missing checkpoint hides the race.

Code before an actor's first checkpoint runs as soon as the schedule starts, in the order the actors are declared, before Parallel makes any choice. If an actor's first action touches shared state, start it with a checkpoint.

Name checkpoints after the step that follows them (`read-stock`, `commit`). The names appear in failure output and traces.

Each checkpoint multiplies the number of orderings:

| Actors | Checkpoints per actor | Schedules |
|---|---|---|
| 2 | 2 | 6 |
| 2 | 3 | 20 |
| 3 | 2 | 90 |
| 3 | 3 | 1,680 |
| 4 | 2 | 2,520 |

`explore` stops after 1,000 schedules by default and reports that it did, so a three-actor scenario with three checkpoints each needs a higher `maxSchedules` (CLI: `--max-schedules`). Keep scenarios small and focused: two or three actors and only the checkpoints that matter.

## State

Everything the actors share goes into the object returned by `createState`. It is called for every schedule, so each run starts from the same state.

Don't keep scenario state in module-level variables. They survive from one schedule to the next, so later runs start from a different state than earlier ones. If that changes which checkpoints actors reach, Parallel stops with a nondeterminism report (see [nondeterminism and replay](04-nondeterminism-and-replay.md)). If it doesn't, results are silently wrong.

## Invariants

An invariant is `{ name, check, describeFailure? }`. `check(state)` returns `true` if the final state is acceptable, and `describeFailure(state)` produces the message shown when it isn't:

```ts
invariants: [{
  name: 'no-overselling',
  check: ({ sold }) => sold <= 1,
  describeFailure: ({ sold }) => `sold ${sold} items, but only 1 was in stock`,
}],
```

Invariants are checked once per schedule, after all actors have finished. They are not checked when an actor threw (the outcome is `actor_error`), when the run hit `maxSteps` (`incomplete`), or when it stalled (`stalled`). An invariant that throws is reported as an actor error from `(invariant)`.

## Testing existing code

Scenarios are most useful when they run your real code rather than a copy of it. Add an optional pause function to the code you want to test, at the points where it awaits something in production (a database call, a request). It does nothing by default; a scenario passes `checkpoint` instead:

```ts
// src/accounts.ts
export type Accounts = Map<string, number>;
export type Pause = (label: string) => Promise<void>;

export async function withdraw(accounts: Accounts, id: string, amount: number, pause: Pause = async () => {}): Promise<boolean> {
  const balance = accounts.get(id) ?? 0;
  await pause('after-read');   // in production: the await of the database read
  if (balance < amount) return false;
  accounts.set(id, balance - amount);
  return true;
}
```

```ts
// scenarios/withdraw.ts
import { defineScenario } from '@aliloraf/parallel-sdk';
import { withdraw } from '../src/accounts.ts';
import type { Accounts } from '../src/accounts.ts';

type State = { accounts: Accounts; approved: number };

export default defineScenario<State>({
  name: 'concurrent-withdrawals',
  createState: () => ({ accounts: new Map([['acct-1', 100]]), approved: 0 }),
  actors: ['atm', 'online'].map((id) => ({
    id,
    async run({ state, checkpoint }) {
      await checkpoint('start');
      if (await withdraw(state.accounts, 'acct-1', 80, checkpoint)) state.approved++;
    },
  })),
  invariants: [{
    name: 'balance-matches',
    check: ({ accounts, approved }) => accounts.get('acct-1') === 100 - 80 * approved,
    describeFailure: ({ accounts, approved }) => `${approved} withdrawals approved, balance is ${accounts.get('acct-1')}`,
  }],
});
```

`npx --no parallel-sim test scenarios/withdraw.ts` finds the lost update: both withdrawals read a balance of 100 before either writes, so both are approved and the balance ends up at 20, although 160 was withdrawn. One of them should have been rejected:

```text
VIOLATION balance-matches: 2 withdrawals approved, balance is 20
```

## TypeScript

Parallel loads TypeScript scenarios with Node.js's built-in type stripping, so there's no build step, but the scenario and everything it imports must follow Node.js's rules:

- Only syntax that can be erased: no `enum`, `namespace` or constructor parameter properties.
- `import type` for imports that are only types.
- Relative imports with their `.ts` extension, as in `import { withdraw } from '../src/accounts.ts'`.

These `tsconfig.json` settings make `tsc` enforce the same rules: `"module": "nodenext"`, `"verbatimModuleSyntax": true`, `"erasableSyntaxOnly": true`, `"allowImportingTsExtensions": true`, `"noEmit": true`.

If your code can't follow them, either write the scenario in JavaScript (`.js`/`.mjs`), register a TypeScript loader yourself (`NODE_OPTIONS=--import=tsx npx --no parallel-sim test ...`), or run scenarios through the engine from a test runner that compiles TypeScript, such as Vitest.

## Asynchronous work between checkpoints

Actors can await other things between checkpoints, but Parallel doesn't interleave that work and waits for it to finish before making the next decision. Keep it short and deterministic:

- If an actor doesn't reach its next checkpoint or finish within `stepTimeoutMs` (10 seconds by default; CLI: `--step-timeout`), the schedule is reported as stalled and exploration stops.
- Timers, randomness, the current time and real I/O can make runs behave differently from one schedule to the next. Prefer in-memory fakes in scenarios.
- When a run ends early, Parallel aborts `context.signal` and rejects pending checkpoints with `SimulationCancelledError`. Pass the signal to APIs that accept one (`fetch(url, { signal })`) so they stop too. Parallel cannot cancel work that ignores it.

[Execution lifecycle](03-execution-lifecycle.md) describes these rules in detail.

## Running scenarios

From the command line, with the CLI installed in your project (see the README's [installation instructions](../README.md#installation)):

```bash
npx --no parallel-sim test scenarios/withdraw.ts --trace-out traces/withdraw.json
npx --no parallel-sim replay traces/withdraw.json scenarios/withdraw.ts
```

`--no` stops npx from installing an unrelated `parallel-sim` package from the registry if the CLI isn't installed.

From code, `explore(scenario, options)` takes these options:

| Option | Default | Meaning |
|---|---|---|
| `maxSchedules` | 1000 | Stop after this many schedules. |
| `maxSteps` | 100 | Maximum checkpoint decisions in one schedule. |
| `stepTimeoutMs` | 10000 | Time an actor may take to reach its next checkpoint. |
| `stopOnFailure` | `false` | Stop at the first failing schedule. |

Check `summary.complete` before trusting a passing result. It is `false` whenever exploration stopped early; `limitReached` (`maxSchedules` or `maxSteps`) and `haltReason` (`stalled`, `abandoned_work`, `nondeterministic`, `stop_on_failure`) say why.

## When something goes wrong

| Symptom | Likely cause |
|---|---|
| `Actor a finished while checkpoint 'write' was still pending (missing await?)` | A `checkpoint()` call without `await`. |
| `Actor a reached overlapping checkpoints` | Two checkpoints at once in one actor, for example inside `Promise.all`. |
| `Exploration halted: stalled` | An actor waits on something that never resolves, or is slower than the step timeout. |
| `Exploration halted: nondeterministic` | Runs differ between schedules: state outside `createState`, randomness, time or I/O. |
| `Limit reached: maxSchedules` | Too many orderings for the bound. Raise it or remove checkpoints that don't matter. |
| `Cannot load TypeScript scenario …` | Node.js older than 22.18, or type stripping disabled. |
| `… uses TypeScript syntax that cannot be stripped …` | `enum`, `namespace` or parameter properties in the scenario or code it imports. |
| `Invalid scenario exported by …` | The default (or `scenario`) export isn't a scenario object. |
