import { attempt, defineScenario } from '@aliloraf/parallel-sdk';
import type { Attempt, Scenario } from '@aliloraf/parallel-sdk';
import { OutOfStockError, sellOneUnit, sellOneUnitUnsafe, stockKey } from '../src/inventory.ts';
import type { StockItem } from '../src/inventory.ts';
import { MemoryStore } from '../src/store.ts';

const SKU = 'sku-1';
const STOCK = 1;

type State = { store: MemoryStore; attempts: Attempt<void>[] };

const sold = (attempts: readonly Attempt<void>[]) => attempts.filter(({ ok }) => ok).length;
const left = (store: MemoryStore) => store.peek<StockItem>(stockKey(SKU))?.quantity;

/** Two customers buy the last unit of the same SKU at the same time. */
export function oversellScenario({ safe, name = safe ? 'shop-oversell-fixed' : 'shop-oversell' }: { safe: boolean; name?: string }): Scenario<State> {
  const sell = safe ? sellOneUnit : sellOneUnitUnsafe;
  return defineScenario<State>({
    name,
    createState: () => ({
      store: new MemoryStore({ [stockKey(SKU)]: { sku: SKU, quantity: STOCK } satisfies StockItem }),
      attempts: [],
    }),
    actors: ['customer-a', 'customer-b'].map((id) => ({
      id,
      async run({ state, checkpoint }) {
        const result = await attempt(() => sell(state.store, SKU, checkpoint), (error) => error instanceof OutOfStockError);
        state.attempts.push(result);
      },
    })),
    invariants: [{
      name: 'stock-matches-sales',
      check: ({ store, attempts }) => left(store) === STOCK - sold(attempts),
      describeFailure: ({ store, attempts }) => `${sold(attempts)} of ${STOCK} unit(s) sold, but ${left(store)} left in stock`,
    }],
  });
}

export default oversellScenario({ safe: false });
