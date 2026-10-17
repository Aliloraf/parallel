import type { Decision, ExploreResult, ReplayResult, Trace } from '@aliloraf/parallel-engine';
import type { CliError } from './errors.ts';

/** Version of the `--json` report format. Increased only for incompatible changes. */
export const REPORT_VERSION = 1;

export type Result = 'passed' | 'failed' | 'incomplete' | 'nondeterministic' | 'diverged' | 'error';
export type Classification = { result: Exclude<Result, 'error'>; exitCode: 0 | 1 | 3 | 4 };

/**
 * Exit-code precedence, highest first: 2 (usage or input error) and 5 (runtime
 * error) are raised as `CliError`s; then 4 (nondeterminism or divergence),
 * 1 (failures), 3 (incomplete exploration) and 0.
 */
export function classifyExploration(summary: ExploreResult): Classification {
  // Failures found before nondeterminism are kept in the report, but the
  // exploration as a whole can no longer be trusted.
  if (summary.nondeterminism) return { result: 'nondeterministic', exitCode: 4 };
  if (summary.failures.length > 0) return { result: 'failed', exitCode: 1 };
  if (!summary.complete) return { result: 'incomplete', exitCode: 3 };
  return { result: 'passed', exitCode: 0 };
}

export function classifyReplay(replayed: ReplayResult): Classification {
  if (replayed.status === 'replay_diverged') return { result: 'diverged', exitCode: 4 };
  if (replayed.trace.outcome === 'passed') return { result: 'passed', exitCode: 0 };
  if (replayed.trace.outcome === 'incomplete') return { result: 'incomplete', exitCode: 3 };
  return { result: 'failed', exitCode: 1 };
}

// When exploration halts, the last explored schedule caused it, except for
// nondeterminism: the diverged run is reported separately, not as a schedule.
const haltTraceOf = (summary: ExploreResult) =>
  (summary.haltReason && summary.haltReason !== 'nondeterministic' ? summary.outcomes.at(-1) ?? null : null);

export function testReport(summary: ExploreResult, tracePath: string | null) {
  const { result, exitCode } = classifyExploration(summary);
  const count = (outcome: Trace['outcome']) => summary.failures.filter((trace) => trace.outcome === outcome).length;
  return {
    reportVersion: REPORT_VERSION,
    command: 'test' as const,
    result,
    exitCode,
    scenario: summary.scenario,
    schedulesExplored: summary.schedulesExplored,
    failureCount: summary.failures.length,
    failuresByOutcome: { invariant_failed: count('invariant_failed'), actor_error: count('actor_error'), stalled: count('stalled') },
    complete: summary.complete,
    limitReached: summary.limitReached,
    haltReason: summary.haltReason,
    abandonedWork: summary.abandonedWork,
    haltTrace: haltTraceOf(summary),
    nondeterminism: summary.nondeterminism,
    firstFailure: summary.failures[0] ?? null,
    tracePath,
  };
}

export function replayReport(replayed: ReplayResult) {
  const { result, exitCode } = classifyReplay(replayed);
  return { reportVersion: REPORT_VERSION, command: 'replay' as const, result, exitCode, ...replayed };
}

/** An error report; `report` holds the regular report fields when the run itself completed. */
export function errorReport(command: 'test' | 'replay' | null, error: CliError, report?: object) {
  return {
    ...report,
    reportVersion: REPORT_VERSION,
    command,
    result: 'error' as const,
    exitCode: error.exitCode,
    error: { code: error.code, message: error.message, ...(error.detail === undefined ? {} : { detail: error.detail }) },
  };
}

// ---------------------------------------------------------------------------
// Text output.

const list = (decisions: readonly Decision[]) =>
  (decisions.length > 0 ? decisions.map(({ actor, checkpoint }) => `${actor}:${checkpoint}`).join(', ') : '(none)');

/** The schedule of a trace and what went wrong in it. */
function traceDetails(trace: Trace): string[] {
  const lines = trace.decisions.map((decision, i) => `  ${i + 1}. ${decision.actor}: ${decision.checkpoint}`);
  for (const violation of trace.violations) lines.push(`  VIOLATION ${violation.name}: ${violation.detail}`);
  for (const error of trace.errors) lines.push(`  ERROR ${error.actor}: ${error.message}`);
  if (trace.stall) {
    const { afterDecisions, timeoutMs, actors } = trace.stall;
    lines.push(`  STALLED after ${afterDecisions} decision(s): no checkpoint or completion within ${timeoutMs} ms`);
    for (const { actor, lastCheckpoint, settledAfterAbort } of actors) {
      lines.push(`    ${actor} (last checkpoint: ${lastCheckpoint ?? 'none'}) ${settledAfterAbort ? 'settled after abort' : 'still running, abandoned'}`);
    }
  }
  return lines;
}

const teardownLines = (trace: { teardown?: Trace['teardown'] } | null) =>
  (trace?.teardown ?? []).map(({ actor, status, detail }) => `  TEARDOWN ${actor}: ${status} (${detail})`);

export function formatTest(summary: ExploreResult, options: { tracePath?: string; traceWritten: boolean; result?: Result }): string {
  const report = testReport(summary, null);
  const breakdown = Object.entries(report.failuresByOutcome).filter(([, n]) => n > 0).map(([outcome, n]) => `${outcome}: ${n}`).join(', ');
  const lines = [
    `Scenario: ${summary.scenario}`,
    `Schedules explored: ${summary.schedulesExplored}`,
    `Failures: ${summary.failures.length}${breakdown ? ` (${breakdown})` : ''}`,
    `Exploration complete: ${summary.complete}`,
  ];
  if (summary.limitReached === 'maxSchedules') lines.push('Exploration incomplete: stopped at the --max-schedules limit; raise it to explore more schedules.');
  if (summary.limitReached === 'maxSteps') lines.push('Exploration incomplete: a schedule reached the --max-steps limit; raise it to let schedules run longer.');
  if (summary.haltReason) lines.push(`Exploration halted: ${summary.haltReason}`);
  lines.push(...teardownLines(report.haltTrace));
  const { nondeterminism } = summary;
  if (nondeterminism) {
    lines.push(
      `  NONDETERMINISM after ${nondeterminism.afterDecisions} decision(s) of forced prefix [${list(nondeterminism.prefix)}]`,
      `    expected choices: ${list(nondeterminism.expected)}`,
      `    observed choices: ${list(nondeterminism.observed)}`,
      ...teardownLines(nondeterminism),
    );
  }
  const firstFailure = summary.failures[0];
  if (firstFailure) lines.push('', `First failure (${firstFailure.outcome}):`, ...traceDetails(firstFailure));
  if (options.tracePath !== undefined) {
    if (!firstFailure) lines.push('No failure found; no trace written.');
    else if (options.traceWritten) lines.push(`Saved trace: ${options.tracePath}`);
  }
  lines.push('', `Result: ${options.result ?? report.result}`);
  return `${lines.join('\n')}\n`;
}

export function formatReplay(replayed: ReplayResult, recorded: Trace, tracePath: string): string {
  const lines = [`Trace: ${tracePath}`, `Scenario: ${recorded.scenario}`];
  if (replayed.status === 'replayed') {
    lines.push(`Replay reproduced the trace (${replayed.trace.outcome}).`, ...traceDetails(replayed.trace), ...teardownLines(replayed.trace));
  } else {
    lines.push(`Replay diverged: ${replayed.reason}`);
    const { divergence, observed } = replayed;
    if (divergence.kind === 'decision_not_eligible') {
      lines.push(`  recorded decision ${list([divergence.expected])} after ${divergence.afterDecisions} decision(s); eligible: ${list(divergence.eligible)}`);
    } else if (divergence.kind === 'continued') {
      lines.push(`  still eligible after ${divergence.afterDecisions} decision(s): ${list(divergence.eligible)}`);
    } else if (divergence.kind === 'result_mismatch' && observed) {
      if (divergence.fields.includes('outcome')) lines.push(`  recorded outcome: ${recorded.outcome}, observed: ${observed.outcome}`);
      lines.push('  Observed run:', ...traceDetails(observed).map((line) => `  ${line}`));
    }
  }
  lines.push('', `Result: ${classifyReplay(replayed).result}`);
  return `${lines.join('\n')}\n`;
}
