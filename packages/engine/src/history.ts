import type { Decision } from './index.ts';

/**
 * Scheduling history used to detect nondeterminism during exploration.
 *
 * Every value here is deep-frozen. Pending branches share choice points by
 * reference with each other and with the run that recorded them, so no run
 * can alter the expectations recorded for another branch.
 */

/** The decisions eligible at one scheduling step, in scenario actor order. */
export type ChoicePoint = readonly Readonly<Decision>[];

/** A schedule prefix still to be explored, with the choice point observed at each of its steps. */
export type Branch = {
  readonly prefix: readonly Readonly<Decision>[];
  readonly expected: readonly ChoicePoint[];
};

const frozenDecision = ({ actor, checkpoint }: Decision): Readonly<Decision> => Object.freeze({ actor, checkpoint });

export const ROOT_BRANCH: Branch = Object.freeze({ prefix: Object.freeze([]), expected: Object.freeze([]) });

/** A deep-frozen copy of the eligible decisions at one step. */
export function choicePoint(eligible: readonly Decision[]): ChoicePoint {
  return Object.freeze(eligible.map(frozenDecision));
}

/** True if `observed` offers exactly the choices recorded in `expected`, in the same order. */
export function sameChoices(expected: ChoicePoint, observed: readonly Decision[]): boolean {
  return expected.length === observed.length
    && expected.every((choice, i) => choice.actor === observed[i]!.actor && choice.checkpoint === observed[i]!.checkpoint);
}

/**
 * The unexplored sibling that takes `option` at the current step. `choices`
 * must already hold the choice point of the current step, i.e. one more entry
 * than `decisions`.
 */
export function branchAt(decisions: readonly Decision[], choices: readonly ChoicePoint[], option: Readonly<Decision>): Branch {
  if (choices.length !== decisions.length + 1) throw new Error('branchAt: choices must include the current step');
  return Object.freeze({
    prefix: Object.freeze([...decisions.map(frozenDecision), frozenDecision(option)]),
    expected: Object.freeze(choices.slice()),
  });
}
