// Packs the workspace packages into real npm tarballs, installs them into an
// independent project outside the repository, and exercises them only through
// what was installed. Run with `npm run test:integration` (builds first).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = ['@aliloraf/parallel-sdk', '@aliloraf/parallel-engine', '@aliloraf/parallel-cli'] as const;
const VERSION = JSON.parse(readFileSync(join(root, 'packages/sdk/package.json'), 'utf8')).version as string;
const isWindows = process.platform === 'win32';

/** Runs npm through the same npm CLI that launched this script, without a shell, on every platform. */
function npm(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 })
    : spawnSync(isWindows ? 'npm.cmd' : 'npm', args, { cwd, env, encoding: 'utf8', timeout: 120_000, shell: isWindows });
  if (result.error) throw result.error;
  return result;
}

type PackFile = { path: string };
type PackResult = { name: string; version: string; filename: string; files: PackFile[] };

let work: string;
let consumer: string;
let packs: PackResult[];

/** Runs the installed `parallel-sim` bin through npm's own bin resolution (the .cmd shim on Windows). */
function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return npm(['exec', '--offline', '--no', '--', 'parallel-sim', ...args], consumer, env);
}
function node(args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd: consumer, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  return result;
}
function write(relative: string, content: string) {
  const path = join(consumer, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}
const manifest = (name: string) => JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));

before(() => {
  work = mkdtempSync(join(tmpdir(), 'parallel-packaging-'));
  const tarballs = join(work, 'tarballs');
  mkdirSync(tarballs);
  const pack = npm(['pack', '--workspaces', '--json', '--pack-destination', tarballs], root);
  assert.equal(pack.status, 0, pack.stderr);
  packs = JSON.parse(pack.stdout);

  // An independent project: outside the repository, no workspace links, offline install of the tarballs only.
  consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2));
  const install = npm(['install', '--offline', '--no-audit', '--no-fund', ...packs.map((p) => join(tarballs, p.filename))], consumer);
  assert.equal(install.status, 0, install.stderr);
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tarball integrity.

test('every workspace package is packed at the same version', () => {
  assert.deepEqual(packs.map((p) => p.name).sort(), [...PACKAGES].sort());
  assert.ok(packs.every((p) => p.version === VERSION));
});

test('tarballs contain only distributable files', () => {
  const allowed = /^(package\.json|README\.md|LICENSE|dist\/.+\.(js|d\.ts|js\.map))$/;
  for (const pack of packs) {
    const paths = pack.files.map((file) => file.path);
    for (const path of paths) assert.match(path, allowed, `${pack.name} must not publish ${path}`);
    for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/index.js']) {
      if (required === 'dist/index.js' && pack.name === '@aliloraf/parallel-cli') continue;
      assert.ok(paths.includes(required), `${pack.name} is missing ${required}`);
    }
    assert.ok(!paths.some((path) => path.endsWith('.ts') && !path.endsWith('.d.ts')), `${pack.name} publishes TypeScript source`);
  }
});

test('every export, type and bin target exists in the installed packages, with no development conditions', () => {
  for (const name of PACKAGES) {
    const pkg = manifest(name);
    const dir = join(consumer, 'node_modules', name);
    const targets: string[] = [];
    const collect = (value: unknown, path: string) => {
      if (typeof value === 'string') targets.push(value);
      else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          if (!key.startsWith('.')) assert.ok(['types', 'default'].includes(key), `${name} exports ${path} uses condition "${key}"`);
          collect(nested, `${path}/${key}`);
        }
      }
    };
    collect(pkg.exports, 'exports');
    if (pkg.types) targets.push(pkg.types);
    if (pkg.bin) targets.push(...Object.values(pkg.bin as Record<string, string>));
    assert.ok(targets.length > 0);
    for (const target of targets) assert.ok(existsSync(join(dir, target)), `${name}: ${target} does not exist`);
    assert.equal(pkg.license, 'Apache-2.0');
    assert.equal(pkg.engines.node, '>=22.18.0');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.scripts, undefined, `${name} must not ship lifecycle scripts`);
    assert.equal(Object.keys(pkg.dependencies ?? {}).filter((dep) => !dep.startsWith('@aliloraf/parallel-')).length, 0, `${name} has external runtime dependencies`);
    assert.equal(readFileSync(join(dir, 'LICENSE'), 'utf8'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  }
});

test('the SDK is installed exactly once and shared by the engine and CLI', () => {
  const copies: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (path.endsWith(join('@aliloraf', 'parallel-sdk'))) copies.push(path);
      walk(path);
    }
  };
  walk(join(consumer, 'node_modules'));
  assert.equal(copies.length, 1, copies.join('\n'));
  assert.equal(manifest('@aliloraf/parallel-engine').peerDependencies['@aliloraf/parallel-sdk'], `^${VERSION}`);
  assert.equal(manifest('@aliloraf/parallel-cli').dependencies['@aliloraf/parallel-engine'], VERSION);
});

// ---------------------------------------------------------------------------
// The installed CLI.

const failingScenario = `import { defineScenario } from '@aliloraf/parallel-sdk';
import type { StepContext } from '@aliloraf/parallel-sdk';

type State = { count: number };
const increment = async ({ state, checkpoint }: StepContext<State>) => {
  await checkpoint('read');
  const seen = state.count;
  await checkpoint('write');
  state.count = seen + 1;
};

export default defineScenario<State>({
  name: 'consumer-lost-update',
  createState: () => ({ count: 0 }),
  actors: [{ id: 'a', run: increment }, { id: 'b', run: increment }],
  invariants: [{ name: 'both-increments', check: ({ count }) => count === 2, describeFailure: ({ count }) => \`count is \${count}\` }],
});
`;

test('parallel-sim reports its version and usage', () => {
  const version = cli(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), VERSION);
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /parallel-sim test <scenario>/);
  assert.match(help.stdout, /parallel-sim replay <trace>/);
});

test('parallel-sim tests a TypeScript scenario that imports the installed SDK', () => {
  const file = write('scenarios/lost-update.ts', failingScenario);
  const result = cli(['test', file, '--json']);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scenario, 'consumer-lost-update');
  assert.equal(report.schedulesExplored, 6);
  assert.equal(report.failureCount, 4);
  assert.equal(report.complete, true);
});

test('parallel-sim passes a correct scenario with exit status 0', () => {
  const file = write('scenarios/passing.mts', `import { defineScenario } from '@aliloraf/parallel-sdk';
export default defineScenario<{ count: number }>({
  name: 'consumer-passing',
  createState: () => ({ count: 0 }),
  actors: ['a', 'b'].map((id) => ({ id, async run({ state, checkpoint }) { await checkpoint('increment'); state.count++; } })),
  invariants: [{ name: 'both', check: ({ count }) => count === 2 }],
});
`);
  const result = cli(['test', file]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Exploration complete: true/);
});

test('parallel-sim exports a failure trace and replays it', () => {
  const file = write('scenarios/lost-update.ts', failingScenario);
  const tracePath = join(consumer, 'traces', 'lost-update.json');
  const tested = cli(['test', file, '--trace-out', tracePath]);
  assert.equal(tested.status, 1, tested.stderr);
  assert.match(tested.stdout, /VIOLATION both-increments: count is 1/);
  const replayed = cli(['replay', tracePath, file, '--json']);
  assert.equal(replayed.status, 1, replayed.stderr);
  const output = JSON.parse(replayed.stdout);
  assert.equal(output.status, 'replayed');
  assert.deepEqual(output.trace, JSON.parse(readFileSync(tracePath, 'utf8')));
});

test('parallel-sim loads JavaScript scenarios and scenarios importing application TypeScript', () => {
  write('app/counter.ts', 'export type Counter = { value: number };\nexport const bump = (counter: Counter): void => { counter.value++; };\n');
  const tsFile = write('scenarios/app.ts', `import { defineScenario } from '@aliloraf/parallel-sdk';
import { bump } from '../app/counter.ts';
import type { Counter } from '../app/counter.ts';
export const scenario = defineScenario<Counter>({
  name: 'consumer-app',
  createState: () => ({ value: 0 }),
  actors: ['a', 'b'].map((id) => ({ id, async run({ state, checkpoint }) { await checkpoint('bump'); bump(state); } })),
  invariants: [{ name: 'both', check: ({ value }) => value === 2 }],
});
`);
  assert.equal(cli(['test', tsFile]).status, 0);
  const jsFile = write('scenarios/plain.mjs', `import { defineScenario } from '@aliloraf/parallel-sdk';
export default defineScenario({
  name: 'consumer-js',
  createState: () => ({ n: 0 }),
  actors: ['a', 'b'].map((id) => ({ id, async run({ state, checkpoint }) { await checkpoint('step'); state.n++; } })),
  invariants: [{ name: 'both', check: (state) => state.n === 2 }],
});
`);
  assert.equal(cli(['test', jsFile]).status, 0);
});

test('parallel-sim runs its built-in demo scenarios', () => {
  assert.equal(cli(['test', 'inventory-buggy']).status, 1);
  assert.equal(cli(['test', 'inventory-fixed']).status, 0);
});

test('parallel-sim explains when TypeScript scenarios cannot be loaded', () => {
  const file = write('scenarios/lost-update.ts', failingScenario);
  const result = cli(['test', file], { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /type stripping/i);
  assert.match(result.stderr, /22\.18/);
  const enumFile = write('scenarios/enum.ts', 'enum Mode { A }\nexport default { mode: Mode.A };\n');
  const syntax = cli(['test', enumFile]);
  assert.equal(syntax.status, 2);
  assert.match(syntax.stderr, /cannot be stripped/i);
});

// ---------------------------------------------------------------------------
// The installed libraries.

test('the engine is usable programmatically from ESM, with one shared SDK', () => {
  write('program.mjs', `import { explore, replay, DEFAULT_STEP_TIMEOUT_MS } from '@aliloraf/parallel-engine';
import { defineScenario, SimulationCancelledError } from '@aliloraf/parallel-sdk';
const seen = [];
const scenario = defineScenario({
  name: 'programmatic',
  createState: () => ({}),
  actors: [
    { id: 'a', async run({ checkpoint }) { try { await checkpoint('a1'); await checkpoint('a2'); } catch (error) { seen.push(error instanceof SimulationCancelledError); throw error; } } },
    { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
  ],
  invariants: [{ name: 'ok', check: () => true }],
});
const bounded = await explore(scenario, { maxSteps: 1, maxSchedules: 1 });
const replayed = await replay(scenario, bounded.outcomes[0]);
console.log(JSON.stringify({ timeout: DEFAULT_STEP_TIMEOUT_MS, outcome: bounded.outcomes[0].outcome, replay: replayed.status, cancellationSeenAsSdkError: seen[0] }));
`);
  const result = node(['program.mjs']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { timeout: 10_000, outcome: 'incomplete', replay: 'replayed', cancellationSeenAsSdkError: true });
});

test('the packages can be required from CommonJS', () => {
  write('program.cjs', `const { explore } = require('@aliloraf/parallel-engine');
const { defineScenario } = require('@aliloraf/parallel-sdk');
explore(defineScenario({
  name: 'cjs', createState: () => ({}),
  actors: [{ id: 'a', async run({ checkpoint }) { await checkpoint('a'); } }, { id: 'b', async run({ checkpoint }) { await checkpoint('b'); } }],
  invariants: [{ name: 'ok', check: () => true }],
})).then((summary) => console.log(JSON.stringify({ schedulesExplored: summary.schedulesExplored, complete: summary.complete })));
`);
  // Print a string: console.log() colors non-string values when FORCE_COLOR is
  // set, which `node --test` does for its subprocesses when run in a terminal.
  const result = node(['program.cjs']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { schedulesExplored: 2, complete: true });
});

test('internal modules are not reachable through package subpaths', () => {
  write('deep.mjs', `const attempts = ['@aliloraf/parallel-engine/dist/history.js', '@aliloraf/parallel-engine/history', '@aliloraf/parallel-sdk/dist/index.js', '@aliloraf/parallel-cli/dist/cli.js', '@aliloraf/parallel-cli'];
const codes = [];
for (const specifier of attempts) {
  try { await import(specifier); codes.push('imported'); } catch (error) { codes.push(error.code); }
}
console.log(JSON.stringify(codes));
`);
  const result = node(['deep.mjs']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), Array(5).fill('ERR_PACKAGE_PATH_NOT_EXPORTED'));
});

test('the shipped type declarations type-check a strict consumer project, and catch misuse', () => {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  // Self-contained: does not rely on files written by other tests.
  write('typed/lost-update.ts', failingScenario);
  write('typed/app/counter.ts', 'export type Counter = { value: number };\nexport const bump = (counter: Counter): void => { counter.value++; };\n');
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
      allowImportingTsExtensions: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true,
      typeRoots: [join(root, 'node_modules', '@types')], types: ['node'],
    },
    files: ['typed/lost-update.ts', 'typed/app/counter.ts', 'typed-program.ts'],
  }));
  write('typed-program.ts', `import { explore, replay, validateTrace } from '@aliloraf/parallel-engine';
import type { ExploreResult, ReplayResult, Trace } from '@aliloraf/parallel-engine';
import scenario from './typed/lost-update.ts';
const summary: ExploreResult = await explore(scenario, { maxSchedules: 10, stepTimeoutMs: 1_000 });
const trace: Trace = validateTrace(JSON.parse(JSON.stringify(summary.failures[0])));
const result: ReplayResult = await replay(scenario, trace);
if (result.status === 'replay_diverged') console.log(result.divergence.kind);
`);
  const clean = node([tsc, '-p', 'tsconfig.json']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);

  write('misuse.ts', `import { explore } from '@aliloraf/parallel-engine';
import { defineScenario } from '@aliloraf/parallel-sdk';
const scenario = defineScenario<{ n: number }>({ name: 'x', createState: () => ({ n: 0 }), actors: [], invariants: [] });
await explore(scenario, { maxSchedules: 'many' });
`);
  writeFileSync(join(consumer, 'tsconfig.misuse.json'), JSON.stringify({ extends: './tsconfig.json', files: ['misuse.ts'] }));
  const misuse = node([tsc, '-p', 'tsconfig.misuse.json']);
  assert.notEqual(misuse.status, 0);
  // `maxSchedules: 'many'` (line 4) must be rejected by the shipped ExploreOptions type.
  assert.match(misuse.stdout, /misuse\.ts\(4,\d+\): error TS2322: Type 'string' is not assignable to type 'number'/);
});

test('the code examples in the published READMEs work as documented', () => {
  const codeBlocks = (name: string) => [...readFileSync(join(consumer, 'node_modules', name, 'README.md'), 'utf8')
    .matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const [scenario] = codeBlocks('@aliloraf/parallel-sdk');
  const [programmatic] = codeBlocks('@aliloraf/parallel-engine');
  assert.ok(scenario && programmatic, 'README examples not found');
  const dir = join(consumer, 'docs-example');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last-item.ts'), scenario);
  writeFileSync(join(dir, 'last-item.test.ts'), programmatic);

  const viaCli = cli(['test', join(dir, 'last-item.ts')]);
  assert.equal(viaCli.status, 1, viaCli.stderr);
  assert.match(viaCli.stdout, /VIOLATION no-overselling/);
  const viaEngine = spawnSync(process.execPath, ['--test', 'last-item.test.ts'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(viaEngine.status, 0, viaEngine.stdout + viaEngine.stderr);
});

test('the code examples in the repository README work against the installed packages', () => {
  const blocks = [...readFileSync(join(root, 'README.md'), 'utf8').matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const scenario = blocks.find((block) => block.startsWith('// scenarios/last-item.ts'));
  const programmatic = blocks.find((block) => block.includes("from '@aliloraf/parallel-engine'"));
  assert.ok(scenario && programmatic, 'README examples not found');
  const dir = join(consumer, 'readme-example');
  mkdirSync(join(dir, 'scenarios'), { recursive: true });
  writeFileSync(join(dir, 'scenarios', 'last-item.ts'), scenario);
  writeFileSync(join(dir, 'last-item.test.ts'), programmatic);

  const tracePath = join(dir, 'traces', 'last-item.json');
  const tested = cli(['test', join(dir, 'scenarios', 'last-item.ts'), '--trace-out', tracePath]);
  assert.equal(tested.status, 1, tested.stderr);
  assert.match(tested.stdout, /VIOLATION no-overselling: sold 2 items, but only 1 was in stock/);
  const replayed = cli(['replay', tracePath, join(dir, 'scenarios', 'last-item.ts'), '--json']);
  assert.equal(replayed.status, 1, replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).status, 'replayed');
  const viaEngine = spawnSync(process.execPath, ['--test', 'last-item.test.ts'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(viaEngine.status, 0, viaEngine.stdout + viaEngine.stderr);
});

test('the example in the scenario-writing guide behaves as documented', () => {
  const guide = readFileSync(join(root, 'docs', '06-writing-scenarios.md'), 'utf8');
  const blocks = [...guide.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const accounts = blocks.find((block) => block.startsWith('// src/accounts.ts'));
  const scenario = blocks.find((block) => block.startsWith('// scenarios/withdraw.ts'));
  assert.ok(accounts && scenario, 'guide examples not found');
  const dir = join(consumer, 'guide-example');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'scenarios'), { recursive: true });
  writeFileSync(join(dir, 'src', 'accounts.ts'), accounts);
  writeFileSync(join(dir, 'scenarios', 'withdraw.ts'), scenario);
  const result = cli(['test', join(dir, 'scenarios', 'withdraw.ts')]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /VIOLATION balance-matches: 2 withdrawals approved, balance is 20/);
});

test('the installed parallel-sim follows the exit-code and JSON contract', () => {
  const dir = join(consumer, 'contract');
  mkdirSync(dir, { recursive: true });
  const scenario = (name: string, body: string, check = '() => true') => write(join('contract', `${name}.ts`), `import { defineScenario } from '@aliloraf/parallel-sdk';
export default defineScenario<{ n: number }>({
  name: '${name}', createState: () => ({ n: 0 }),
  actors: ['a', 'b'].map((id) => ({ id, async run({ state, checkpoint }) { ${body} } })),
  invariants: [{ name: 'inv', check: ${check} }],
});
`);
  const passing = scenario('contract-pass', "await checkpoint('step'); state.n++;");
  const failing = scenario('contract-fail', "await checkpoint('step'); state.n++;", '() => false');
  const noisy = scenario('contract-noisy', "console.log('log from', id); process.stdout.write('raw\\n'); await checkpoint('step');");
  const cases: [string[], number, string][] = [
    [['test', passing], 0, 'passed'],
    [['test', failing], 1, 'failed'],
    [['test', passing, '--max-schedules', '1'], 3, 'incomplete'],
    [['test', passing, '--bogus'], 2, 'error'],
    [['test', noisy], 0, 'passed'],
  ];
  for (const [args, exitCode, result] of cases) {
    for (const env of [process.env, { ...process.env, FORCE_COLOR: '1' }]) {
      const run = cli([...args, '--json'], env);
      assert.equal(run.status, exitCode, `${args.join(' ')}: ${run.stderr}`);
      const report = JSON.parse(run.stdout);
      assert.deepEqual([report.reportVersion, report.result, report.exitCode], [1, result, exitCode], args.join(' '));
    }
  }
  assert.match(cli(['test', noisy, '--json']).stderr, /log from a/);

  const tracePath = join(dir, 'nested', 'deeper', 'trace.json');
  assert.equal(cli(['test', failing, '--trace-out', tracePath]).status, 1);
  const replayed = cli(['replay', tracePath, failing]);
  assert.equal(replayed.status, 1, replayed.stderr);
  assert.match(replayed.stdout, /Replay reproduced the trace \(invariant_failed\)/);
  assert.match(replayed.stdout, /Result: failed/);
});

test('the shipped types resolve under node, nodenext and bundler module resolution', () => {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  write('resolution/use.ts', `import { explore, replay } from '@aliloraf/parallel-engine';
import type { ExploreResult } from '@aliloraf/parallel-engine';
import { defineScenario, SimulationCancelledError } from '@aliloraf/parallel-sdk';
import type { StepContext } from '@aliloraf/parallel-sdk';

const scenario = defineScenario<{ n: number }>({
  name: 'resolution',
  createState: () => ({ n: 0 }),
  actors: ['a', 'b'].map((id) => ({ id, async run({ state, checkpoint }: StepContext<{ n: number }>) { await checkpoint('step'); state.n++; } })),
  invariants: [{ name: 'both', check: ({ n }) => n === 2 }],
});
export const check = async (): Promise<ExploreResult> => explore(scenario);
export const cancelled = (error: unknown): boolean => error instanceof SimulationCancelledError;
export { replay };
`);
  // `moduleResolution: node` ignores package exports and needs the top-level `types` field.
  const modes: [string, string][] = [['node', 'commonjs'], ['nodenext', 'nodenext'], ['bundler', 'esnext']];
  for (const [moduleResolution, module] of modes) {
    const config = `tsconfig.${moduleResolution}.json`;
    writeFileSync(join(consumer, 'resolution', config), JSON.stringify({
      compilerOptions: { module, moduleResolution, target: 'ES2022', strict: true, noEmit: true, skipLibCheck: false, typeRoots: [join(root, 'node_modules', '@types')], types: ['node'] },
      files: ['use.ts'],
    }));
    const result = node([tsc, '-p', join('resolution', config)]);
    assert.equal(result.status, 0, `moduleResolution ${moduleResolution}:\n${result.stdout}${result.stderr}`);
  }
});

test('npm finds nothing to correct in the published manifests', () => {
  for (const name of PACKAGES) {
    const copy = join(work, 'manifest-check', name.replace('/', '-'));
    mkdirSync(join(copy, '..'), { recursive: true });
    cpSync(join(consumer, 'node_modules', name), copy, { recursive: true });
    const before = readFileSync(join(copy, 'package.json'), 'utf8');
    const fix = npm(['pkg', 'fix'], copy);
    assert.equal(fix.status, 0, fix.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')), JSON.parse(before), `npm pkg fix would change ${name}`);
  }
});
