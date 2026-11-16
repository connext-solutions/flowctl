import type { DriveStep, Evidence } from './evidence.js';
import { bound, refuse } from './params.js';
import type {
  Binding,
  InvariantFinding,
  InvariantId,
  Refusal,
} from './types.js';

/** The control a drive step acted on, as the parameters name it. */
type Named = { role: string; name: string };

/** Whether a call status is a success (2xx). */
export const accepted = (status: number): boolean =>
  status >= 200 && status < 300;

/** The indexes of the drive steps `pick` keeps, on `page`. */
export const stepsOn = (
  evidence: Evidence,
  page: string,
  pick: (s: DriveStep) => boolean,
): number[] =>
  (evidence.drive?.steps ?? []).flatMap((s, i) =>
    s.page === page && pick(s) ? [i] : [],
  );

/** Whether control `a` and control `b` are the same role and name. */
export const same = (a: Named | undefined, b: Named): boolean =>
  a !== undefined && a.role === b.role && a.name === b.name;

/**
 * A binding over the drive steps of `page` that `pick` keeps. The page must be in the map (the invariant is about a
 * screen that was observed) and the drive must hold at least one such step.
 */
export function bindSteps(
  evidence: Evidence,
  page: string,
  what: string,
  pick: (s: DriveStep) => boolean,
): Binding | Refusal {
  if (!evidence.map.pages.some((p) => p.path === page))
    return refuse('no_evidence', 'the page is not in the map');
  return bound(stepsOn(evidence, page, pick), what);
}

/** A finding on step `index` of the drive record, at `field` of it. */
export function driveFinding(
  invariant: InvariantId,
  evidence: Evidence,
  index: number,
  field: string,
  status?: number,
): InvariantFinding {
  const step = evidence.drive?.steps[index];
  return {
    invariant,
    page: step?.page ?? '/',
    ...(status === undefined ? {} : { status }),
    sourceRef: { kind: 'invariant', ref: invariant },
    observation: {
      kind: 'observation',
      file: 'drive.json',
      pointer: `/steps/${index}/${field}`,
    },
  };
}
