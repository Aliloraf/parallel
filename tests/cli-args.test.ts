import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliArgs } from '../packages/cli/dist/args.js';
import { CliError } from '../packages/cli/dist/errors.js';

function rejects(argv: string[], code: string, message: RegExp) {
  assert.throws(() => parseCliArgs(argv), (error: unknown) => {
    assert.ok(error instanceof CliError, `expected CliError for ${JSON.stringify(argv)}`);
    assert.equal(error.code, code, JSON.stringify(argv));
    assert.equal(error.exitCode, 2);
    assert.match(error.message, message);
    return true;
  });
}

test('parses test with every option, in any position', () => {
  assert.deepEqual(parseCliArgs(['test', 'a.ts']), { command: 'test', scenario: 'a.ts', json: false });
  assert.deepEqual(
    parseCliArgs(['--json', 'test', '--max-schedules', '5', 'a.ts', '--max-steps=7', '--step-timeout', '50', '--trace-out', 't.json']),
    { command: 'test', scenario: 'a.ts', json: true, maxSchedules: 5, maxSteps: 7, stepTimeoutMs: 50, traceOut: 't.json' },
  );
  assert.equal((parseCliArgs(['test', 'a.ts', '--trace-out=--odd.json']) as { traceOut?: string }).traceOut, '--odd.json');
  assert.equal((parseCliArgs(['test', '--', '-weird.ts']) as { scenario?: string }).scenario, '-weird.ts');
});

test('parses replay, with or without a scenario, and with options before it', () => {
  assert.deepEqual(parseCliArgs(['replay', 't.json']), { command: 'replay', trace: 't.json', json: false });
  assert.deepEqual(parseCliArgs(['replay', 't.json', '--step-timeout', '50', 's.ts', '--json']),
    { command: 'replay', trace: 't.json', scenario: 's.ts', json: true, stepTimeoutMs: 50 });
});

test('--help and --version win wherever they appear', () => {
  for (const argv of [['--help'], ['-h'], ['help'], ['test', 'a.ts', '--help'], ['test', '--bogus', '-h'], ['--help', '--version'], ['help', 'test']]) {
    assert.deepEqual(parseCliArgs(argv), { command: 'help' }, JSON.stringify(argv));
  }
  for (const argv of [['--version'], ['-v'], ['replay', 't.json', '--version'], ['test', '--bogus', '--version']]) {
    assert.deepEqual(parseCliArgs(argv), { command: 'version' }, JSON.stringify(argv));
  }
});

test('rejects missing and unexpected positional arguments', () => {
  rejects([], 'missing_argument', /No command given/);
  rejects(['--json'], 'missing_argument', /No command given/);
  rejects(['bogus'], 'unknown_command', /Unknown command 'bogus'/);
  rejects(['test'], 'missing_argument', /test needs a scenario/);
  rejects(['test', 'a.ts', 'b.ts'], 'unexpected_argument', /Unexpected argument 'b\.ts'/);
  rejects(['replay'], 'missing_argument', /replay needs a trace file/);
  rejects(['replay', 't.json', 's.ts', 'extra'], 'unexpected_argument', /Unexpected argument 'extra'/);
});

test('rejects unknown, unsupported, duplicated and misused options', () => {
  rejects(['test', 'a.ts', '--tracout', 't.json'], 'unknown_option', /Unknown option --tracout/);
  rejects(['test', 'a.ts', '-x'], 'unknown_option', /Unknown option -x/);
  rejects(['replay', 't.json', '--trace-out', 'x.json'], 'unsupported_option', /--trace-out is not supported by replay/);
  rejects(['replay', 't.json', '--max-schedules', '3'], 'unsupported_option', /--max-schedules is not supported by replay/);
  rejects(['test', 'a.ts', '--max-schedules', '1', '--max-schedules', '2'], 'duplicate_option', /--max-schedules was given more than once/);
  rejects(['test', 'a.ts', '--json', '--json'], 'duplicate_option', /--json was given more than once/);
  rejects(['test', 'a.ts', '--json=yes'], 'invalid_value', /--json does not take a value/);
});

test('an option never takes the next option as its value', () => {
  rejects(['test', 'a.ts', '--trace-out'], 'missing_value', /Missing --trace-out value/);
  rejects(['test', 'a.ts', '--trace-out', '--json'], 'missing_value', /Missing --trace-out value.*--trace-out=/);
  rejects(['test', 'a.ts', '--max-schedules', '--json'], 'missing_value', /Missing --max-schedules value/);
  rejects(['replay', 't.json', '--step-timeout'], 'missing_value', /Missing --step-timeout value/);
});

test('numeric options accept only positive decimal integers within range', () => {
  for (const value of ['0', '01', '1.5', '0x2', ' 5', '1e3', 'abc', '9007199254740993']) {
    rejects(['test', 'a.ts', '--max-schedules', value], 'invalid_value', /--max-schedules must be a positive integer/);
  }
  rejects(['test', 'a.ts', '--max-steps', '-5'], 'missing_value', /Missing --max-steps value/);
  rejects(['test', 'a.ts', '--step-timeout', '2147483648'], 'invalid_value', /--step-timeout must be an integer from 1 to 2147483647/);
  assert.equal((parseCliArgs(['test', 'a.ts', '--step-timeout', '2147483647']) as { stepTimeoutMs?: number }).stepTimeoutMs, 2_147_483_647);
});
