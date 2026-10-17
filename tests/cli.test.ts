import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../packages/cli/src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/counter/src/scenario.ts', import.meta.url));
const nodeArgs = ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', cli];

function runCli(args: string[]) {
  return spawnSync(process.execPath, [...nodeArgs, ...args], { cwd: root, encoding: 'utf8' });
}

test('CLI loads a custom TypeScript scenario with a default export', () => {
  const result = runCli(['test', example, '--json']);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scenario, 'counter-lost-update');
  assert.equal(report.schedulesExplored, 6);
  assert.equal(report.failureCount, 4);
  assert.equal(report.complete, true);
});

test('CLI saves and replays a failure from an external TypeScript scenario', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-cli-'));
  try {
    const path = join(dir, 'failure.json');
    const first = runCli(['test', example, '--trace-out', path]);
    assert.equal(first.status, 1, first.stderr);
    const trace = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(trace.scenario, 'counter-lost-update');
    const replay = runCli(['replay', path, example]);
    assert.equal(replay.status, 1, replay.stderr); // Known failure returns status 1.
    const output = JSON.parse(replay.stdout);
    assert.equal(output.status, 'replayed');
    assert.deepEqual(output.trace, trace);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI reports invalid or missing scenario exports clearly', () => {
  const missing = runCli(['test', './examples/does-not-exist.ts']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Scenario file not found/);
  const badExtension = runCli(['test', './package.json']);
  assert.equal(badExtension.status, 2);
  assert.match(badExtension.stderr, /Unknown scenario/);
  const dir = mkdtempSync(join(tmpdir(), 'parallel-invalid-'));
  try {
    const invalidFile = join(dir, 'invalid.ts');
    writeFileSync(invalidFile, 'export default { name: "invalid" };\n');
    const invalidExport = runCli(['test', invalidFile]);
    assert.equal(invalidExport.status, 2);
    assert.match(invalidExport.stderr, /Invalid scenario exported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('CLI accepts a named scenario export from a trusted local module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-named-'));
  try {
    const file = join(dir, 'named.ts');
    writeFileSync(file, `export const scenario = {
      name: 'named-example',
      createState: () => ({ count: 0 }),
      actors: [
        { id: 'a', async run({ state, checkpoint }) { await checkpoint('increment'); state.count++; } },
        { id: 'b', async run({ state, checkpoint }) { await checkpoint('increment'); state.count++; } },
      ],
      invariants: [{ name: 'two-increments', check: (state) => state.count === 2 }],
    };`);
    const result = runCli(['test', file, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scenario, 'named-example');
    assert.equal(report.failureCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
