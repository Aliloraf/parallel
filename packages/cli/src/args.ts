import { parseArgs } from 'node:util';
import { CliError } from './errors.ts';

export type TestInvocation = {
  command: 'test';
  scenario: string;
  json: boolean;
  maxSchedules?: number;
  maxSteps?: number;
  stepTimeoutMs?: number;
  traceOut?: string;
};
export type ReplayInvocation = {
  command: 'replay';
  trace: string;
  scenario?: string;
  json: boolean;
  stepTimeoutMs?: number;
};
export type Invocation = { command: 'help' } | { command: 'version' } | TestInvocation | ReplayInvocation;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  'max-schedules': { type: 'string' },
  'max-steps': { type: 'string' },
  'step-timeout': { type: 'string' },
  'trace-out': { type: 'string' },
} as const;
type OptionName = keyof typeof OPTIONS;

const SUPPORTED: Record<'test' | 'replay', readonly OptionName[]> = {
  test: ['json', 'max-schedules', 'max-steps', 'step-timeout', 'trace-out'],
  replay: ['json', 'step-timeout'],
};
/** Largest delay `setTimeout` honors. */
const MAX_STEP_TIMEOUT_MS = 2_147_483_647;

function positiveInteger(flag: string, value: string, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number) || number > max) {
    throw new CliError('invalid_value', max === Number.MAX_SAFE_INTEGER
      ? `${flag} must be a positive integer, got '${value}'`
      : `${flag} must be an integer from 1 to ${max}, got '${value}'`);
  }
  return number;
}

/**
 * Parses and validates the command line. Never loads or runs anything, so a
 * scenario's code only runs once its arguments are known to be valid.
 */
export function parseCliArgs(argv: readonly string[]): Invocation {
  // Tokenize leniently and validate ourselves, so messages and error codes
  // don't depend on Node.js's wording.
  const { tokens } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: false, tokens: true });
  const options = tokens.filter((token) => token.kind === 'option');
  const positionals = tokens.filter((token) => token.kind === 'positional').map((token) => token.value);

  if (options.some((option) => option.name === 'help') || positionals[0] === 'help') return { command: 'help' };
  if (options.some((option) => option.name === 'version')) return { command: 'version' };

  const values = new Map<OptionName, string | true>();
  for (const option of options) {
    const definition = OPTIONS[option.name as OptionName] as { type: 'boolean' | 'string' } | undefined;
    if (!definition) throw new CliError('unknown_option', `Unknown option ${option.rawName}`);
    const name = option.name as OptionName;
    if (values.has(name)) throw new CliError('duplicate_option', `--${name} was given more than once`);
    if (definition.type === 'boolean') {
      if (option.value !== undefined) throw new CliError('invalid_value', `--${name} does not take a value`);
      values.set(name, true);
    } else {
      // Without `=`, a value that looks like an option is almost always a forgotten value.
      if (option.value === undefined || (!option.inlineValue && option.value.startsWith('-'))) {
        throw new CliError('missing_value', `Missing --${name} value`
          + (option.value === undefined ? '' : ` (got '${option.value}'; use --${name}=<value> for a value starting with '-')`));
      }
      values.set(name, option.value);
    }
  }

  const [command, ...rest] = positionals;
  if (command === undefined) throw new CliError('missing_argument', 'No command given; use test or replay (see --help)');
  if (command !== 'test' && command !== 'replay') throw new CliError('unknown_command', `Unknown command '${command}'; use test or replay (see --help)`);
  for (const name of values.keys()) {
    if (!SUPPORTED[command].includes(name)) throw new CliError('unsupported_option', `--${name} is not supported by ${command}`);
  }
  const text = (name: OptionName) => values.get(name) as string | undefined;
  const json = values.has('json');
  const stepTimeout = text('step-timeout');
  const stepTimeoutMs = stepTimeout === undefined ? undefined : positiveInteger('--step-timeout', stepTimeout, MAX_STEP_TIMEOUT_MS);
  const optional = <T>(key: string, value: T | undefined) => (value === undefined ? {} : { [key]: value });

  if (command === 'test') {
    if (rest.length === 0) throw new CliError('missing_argument', 'test needs a scenario: parallel-sim test <scenario>');
    if (rest.length > 1) throw new CliError('unexpected_argument', `Unexpected argument '${rest[1]}'; test takes one scenario`);
    const maxSchedules = text('max-schedules');
    const maxSteps = text('max-steps');
    return {
      command, scenario: rest[0]!, json,
      ...optional('maxSchedules', maxSchedules === undefined ? undefined : positiveInteger('--max-schedules', maxSchedules)),
      ...optional('maxSteps', maxSteps === undefined ? undefined : positiveInteger('--max-steps', maxSteps)),
      ...optional('stepTimeoutMs', stepTimeoutMs),
      ...optional('traceOut', text('trace-out')),
    };
  }
  if (rest.length === 0) throw new CliError('missing_argument', 'replay needs a trace file: parallel-sim replay <trace> [scenario]');
  if (rest.length > 2) throw new CliError('unexpected_argument', `Unexpected argument '${rest[2]}'; replay takes a trace and an optional scenario`);
  return { command, trace: rest[0]!, ...optional('scenario', rest[1]), json, ...optional('stepTimeoutMs', stepTimeoutMs) };
}

/** The command named on the command line, if it is a known one; used to label error reports. */
export function commandOf(argv: readonly string[]): 'test' | 'replay' | null {
  const first = argv.find((arg) => !arg.startsWith('-'));
  return first === 'test' || first === 'replay' ? first : null;
}
