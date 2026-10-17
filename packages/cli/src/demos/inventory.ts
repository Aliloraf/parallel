import { defineScenario } from '@aliloraf/parallel-sdk';
import type { Scenario } from '@aliloraf/parallel-sdk';

type InventoryState = { stock: number; successfulPurchases: number };

export function inventoryScenario(fixed = false): Scenario<InventoryState> {
  const makeActor = (id: string) => ({
    id,
    async run({ state, checkpoint }: { state: InventoryState; checkpoint: (name: string) => Promise<void> }) {
      await checkpoint('read-stock');
      const available = state.stock;
      await checkpoint('commit-purchase');
      // A deliberately buggy read-modify-write; the fixed version re-checks
      // inside the atomic commit segment (real DBs need atomic transactions).
      const canBuy = fixed ? state.stock > 0 : available > 0;
      if (canBuy) {
        state.stock = fixed ? state.stock - 1 : available - 1;
        state.successfulPurchases++;
      }
    },
  });
  return defineScenario({
    name: fixed ? 'inventory-fixed' : 'inventory-buggy',
    createState: () => ({ stock: 1, successfulPurchases: 0 }),
    actors: [makeActor('customer-a'), makeActor('customer-b')],
    invariants: [{
      name: 'no-overselling',
      check: ({ successfulPurchases }) => successfulPurchases <= 1,
      describeFailure: ({ successfulPurchases }) => `Expected at most 1 successful purchase, got ${successfulPurchases}`,
    }],
  });
}
