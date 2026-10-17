import { defineScenario } from '@aliloraf/parallel-sdk';

// Scenarios used to generate the fixed traces in ./traces. Changing them breaks the fixtures.
const passing = [{ name: 'ok', check: () => true }];

export const stallFixture = defineScenario<Record<string, never>>({
  name: 'fixture-stall',
  createState: () => ({}),
  actors: [
    { id: 'a', async run({ checkpoint }) { await checkpoint('a1'); await new Promise<never>(() => {}); } },
    { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
  ],
  invariants: passing,
});

export const boundedErrorFixture = defineScenario<Record<string, never>>({
  name: 'fixture-bounded-error',
  createState: () => ({}),
  actors: [
    { id: 'a', async run({ checkpoint }) { await checkpoint('a1'); throw new Error('boom'); } },
    { id: 'b', async run({ checkpoint }) { for (let i = 0; i < 5; i++) await checkpoint(`b${i}`); } },
  ],
  invariants: passing,
});

export const cleanupErrorFixture = defineScenario<Record<string, never>>({
  name: 'fixture-cleanup-error',
  createState: () => ({}),
  actors: [
    { id: 'a', async run({ checkpoint }) { try { await checkpoint('a1'); await checkpoint('a2'); } catch { throw new Error('cleanup failed'); } } },
    { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
  ],
  invariants: passing,
});
