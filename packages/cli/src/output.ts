/** Writes to the real stdout, bypassing the redirection below. */
let writeReal: ((chunk: string, callback: () => void) => void) | undefined;

/**
 * In `--json` mode, stdout carries only the report. Everything else written
 * to stdout in this process (scenario logs, `console.log`, direct
 * `process.stdout.write` calls) is forwarded to stderr, with its encoding and
 * callback. The redirection is never undone, so that output from scenario
 * work that is still running after the report cannot follow the report on
 * stdout. Writes that bypass `process.stdout.write` (for example to file
 * descriptor 1 directly) are not intercepted.
 */
export function reserveStdoutForReport(): void {
  if (writeReal) return;
  const original = process.stdout.write.bind(process.stdout);
  writeReal = (chunk, callback) => { original(chunk, callback); };
  process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) =>
    process.stderr.write(chunk as string, encoding as BufferEncoding, callback as () => void)) as typeof process.stdout.write;
}

/** Writes CLI output (a report, usage or the version) to stdout and resolves once it has been handed off. */
export function writeStdout(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (writeReal) writeReal(text, resolve);
    else process.stdout.write(text, () => resolve());
  });
}

/** Resolves once everything written so far to stdout and stderr has been flushed. */
export function flushOutput(): Promise<void> {
  return Promise.all([writeStdout(''), new Promise<void>((resolve) => process.stderr.write('', () => resolve()))]).then(() => {});
}
