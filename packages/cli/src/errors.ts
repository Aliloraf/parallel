/** Stable error codes reported by the CLI (in `--json` reports as `error.code`). */
export type ErrorCode =
  | 'missing_argument' | 'unexpected_argument' | 'unknown_command'
  | 'unknown_option' | 'unsupported_option' | 'missing_value' | 'invalid_value' | 'duplicate_option'
  | 'scenario_not_found' | 'scenario_load_failed' | 'invalid_scenario'
  | 'trace_not_found' | 'invalid_trace' | 'trace_write_failed'
  | 'runtime_error';

/**
 * An error the CLI reports to the user. Usage and input errors exit with 2;
 * `runtime_error` (an unexpected failure of the engine or of scenario code
 * outside a controlled step) exits with 5.
 */
export class CliError extends Error {
  override name = 'CliError';
  readonly code: ErrorCode;
  readonly exitCode: 2 | 5;
  /** Optional extra information, such as the location of a scenario load failure. */
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string, options: { detail?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.code = code;
    this.exitCode = code === 'runtime_error' ? 5 : 2;
    this.detail = options.detail;
  }
}
