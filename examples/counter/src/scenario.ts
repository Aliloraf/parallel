import { defineScenario } from '@aliloraf/parallel-sdk';

// Two independent callers each increment the same logical counter.
// Both can read 0 before either writes 1, causing a lost update.
type CounterState = { count: number };

const scenario = defineScenario<CounterState>({
  name: 'counter-lost-update',
  createState: () => ({ count: 0 }),
  actors: ['writer-a', 'writer-b'].map((id) => ({
    id,
    async run({ state, checkpoint }) {
      await checkpoint('read-counter');
      const previous = state.count;
      await checkpoint('write-counter');
      state.count = previous + 1;
    },
  })),
  invariants: [{
    name: 'all-increments-preserved',
    check: ({ count }) => count === 2,
    describeFailure: ({ count }) => `Expected count to be 2, got ${count}`,
  }],
});

export default scenario;
