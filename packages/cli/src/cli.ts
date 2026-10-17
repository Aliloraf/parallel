#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { explore, replay } from '../../engine/src/index.ts';
import type { Trace } from '../../engine/src/index.ts';
import { inventoryScenario } from '../../../examples/inventory/src/scenarios.ts';
import { defineScenario } from '../../sdk/src/index.ts';
import type { Scenario } from '../../sdk/src/index.ts';

const args = process.argv.slice(2);
const usage = 'Usage: node --experimental-strip-types packages/cli/src/cli.ts test <scenario-file.ts|inventory-buggy|inventory-fixed> [--json] [--max-schedules N] [--trace-out path] | replay <trace-file> [scenario-file.ts|inventory-buggy|inventory-fixed]';
function flagValue(key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}
/**
 * Load a built-in example or a trusted local scenario module.
 * The runtime checks provide a readable error before handing the typed scenario
 * to the engine. Modules are executable code; never load untrusted files.
 */
async function loadScenario(input: string): Promise<Scenario<any>> {
  if (input === 'inventory-buggy') return inventoryScenario(false);
  if (input === 'inventory-fixed') return inventoryScenario(true);
  if (!/\.(?:ts|js|mjs)$/.test(input)) {
    throw new Error(`Unknown scenario '${input}'. Provide inventory-buggy, inventory-fixed, or a path to a .ts/.js/.mjs scenario file.`);
  }
  const fullPath = resolve(input);
  if (!existsSync(fullPath)) throw new Error(`Scenario file not found: ${fullPath}`);
  const module = await import(pathToFileURL(fullPath).href);
  const candidate: unknown = module.default ?? module.scenario;
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error(`Scenario file must export a Scenario as default (or named 'scenario'): ${fullPath}`);
  }
  const scenario = candidate as Partial<Scenario<unknown>>;
  if (typeof scenario.name !== 'string' || typeof scenario.createState !== 'function'
      || !Array.isArray(scenario.actors) || !Array.isArray(scenario.invariants)
      || !scenario.actors.every((actor) => typeof actor.id === 'string' && typeof actor.run === 'function')
      || !scenario.invariants.every((invariant) => typeof invariant.name === 'string' && typeof invariant.check === 'function')) {
    throw new Error(`Invalid scenario exported by ${fullPath}: expected name, createState, actors, and invariants.`);
  }
  return defineScenario(scenario as Scenario<unknown>);
}

try {
  const command = args[0];
  if (command === 'test') {
    const name = args[1];
    if (!name) throw new Error(usage);
    const scenario = await loadScenario(name);
    const maxSchedulesArg = flagValue('--max-schedules');
    if (args.includes('--max-schedules') && maxSchedulesArg === undefined) throw new Error('Missing --max-schedules value');
    const maxSchedules = maxSchedulesArg === undefined ? undefined : Number(maxSchedulesArg);
    const summary = await explore(scenario, { maxSchedules });
    const firstFailure = summary.failures[0];
    const output = flagValue('--trace-out');
    if (args.includes('--trace-out') && !output) throw new Error('Missing --trace-out value');
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
    const scenario = await loadScenario(args[2] ?? trace.scenario);
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
