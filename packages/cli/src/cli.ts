#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { explore, replay } from '../../engine/src/index.ts';
import type { Trace } from '../../engine/src/index.ts';
import { inventoryScenario } from '../../../examples/inventory/src/scenarios.ts';

const args = process.argv.slice(2);
const usage = 'Usage: node --experimental-strip-types packages/cli/src/cli.ts test inventory-buggy|inventory-fixed [--json] [--max-schedules N] [--trace-out path] | replay <trace-file> [inventory-buggy|inventory-fixed]';
function flagValue(key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}
function loadScenario(name: string) {
  if (name === 'inventory-buggy') return inventoryScenario(false);
  if (name === 'inventory-fixed') return inventoryScenario(true);
  throw new Error(`Unknown scenario '${name}'. Available: inventory-buggy, inventory-fixed`);
}
try {
  const command = args[0];
  if (command === 'test') {
    const name = args[1];
    if (!name) throw new Error(usage);
    const scenario = loadScenario(name);
    const maxSchedulesArg = flagValue('--max-schedules');
    if (args.includes('--max-schedules') && maxSchedulesArg === undefined) throw new Error('Missing --max-schedules value');
    const maxSchedules = maxSchedulesArg === undefined ? undefined : Number(maxSchedulesArg);
    const summary = await explore(scenario, { maxSchedules });
    const firstFailure = summary.failures[0];
    const output = flagValue('--trace-out');
    if (firstFailure && output) {
      mkdirSync(dirname(resolve(output)), { recursive: true });
      writeFileSync(resolve(output), JSON.stringify(firstFailure, null, 2) + '\n');
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify({
        scenario: summary.scenario,
        schedulesExplored: summary.schedulesExplored,
        failureCount: summary.failures.length,
        complete: summary.complete,
        limitReached: summary.limitReached,
        firstFailure: firstFailure ?? null,
        tracePath: firstFailure && output ? resolve(output) : null,
      }, null, 2));
    } else {
      console.log(`Scenario: ${summary.scenario}`);
      console.log(`Schedules explored: ${summary.schedulesExplored}`);
      console.log(`Failures: ${summary.failures.length}`);
      console.log(`Exploration complete: ${summary.complete}`);
      if (summary.limitReached) console.log(`Limit reached: ${summary.limitReached}`);
      if (firstFailure) {
        console.log('\nFirst failure:');
        firstFailure.decisions.forEach((decision, i) => console.log(`  ${i + 1}. ${decision.actor}: ${decision.checkpoint}`));
        firstFailure.violations.forEach((violation) => console.log(`  VIOLATION ${violation.name}: ${violation.detail}`));
        if (output) console.log(`Saved trace: ${resolve(output)}`);
      }
    }
    process.exitCode = firstFailure || !summary.complete ? 1 : 0;
  } else if (command === 'replay') {
    if (!args[1]) throw new Error(usage);
    const trace = JSON.parse(readFileSync(resolve(args[1]), 'utf8')) as Trace;
    const scenario = loadScenario(args[2] ?? trace.scenario);
    const result = await replay(scenario, trace);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'replayed' && result.trace.outcome === 'passed' ? 0 : 1;
  } else {
    throw new Error(usage);
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 2;
}
