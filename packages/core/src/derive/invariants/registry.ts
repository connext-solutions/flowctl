import {
  CLIENT_BLOCKS_WHAT_SERVER_REJECTS,
  ROUND_TRIP_EQUALITY,
  STATE_CHANGE_AFTER_ACTION,
  SUCCESS_TOAST_IMPLIES_2XX,
} from './templates/behaviour.js';
import {
  CRUD_CREATE_APPEARS,
  CRUD_DELETE_ABSENT,
  CRUD_EDIT_SHOWS,
  RELOAD_KEEPS_DATA,
} from './templates/crud.js';
import { NO_5XX, NO_CONSOLE_ERROR } from './templates/free.js';
import {
  INVARIANT_IDS,
  type Evaluation,
  type Expansion,
  type InvariantId,
  type InvariantTemplate,
  type Refusal,
} from './types.js';

/** Every invariant template, by id. */
export const INVARIANTS: Record<InvariantId, InvariantTemplate> = {
  'crud-create-appears': CRUD_CREATE_APPEARS,
  'crud-edit-shows': CRUD_EDIT_SHOWS,
  'crud-delete-absent': CRUD_DELETE_ABSENT,
  'reload-keeps-data': RELOAD_KEEPS_DATA,
  'no-5xx': NO_5XX,
  'no-console-error': NO_CONSOLE_ERROR,
  'round-trip-equality': ROUND_TRIP_EQUALITY,
  'state-change-after-action': STATE_CHANGE_AFTER_ACTION,
  'success-toast-implies-2xx': SUCCESS_TOAST_IMPLIES_2XX,
  'client-blocks-what-server-rejects': CLIENT_BLOCKS_WHAT_SERVER_REJECTS,
};

/** Whether `id` names an invariant. */
export const isInvariantId = (id: string): id is InvariantId =>
  INVARIANT_IDS.some((known) => known === id);

/** The verdict of invariant `id` on `evidence`: findings, or the refusal that its evidence is missing. */
export const evaluateInvariant = (
  id: InvariantId,
  evidence: unknown,
  params: unknown,
): Evaluation => INVARIANTS[id].evaluate(evidence, params);

/** The assertion invariant `id` expands to for `params` and `evidence`, or why it does not. */
export const expandInvariant = (
  id: InvariantId,
  evidence: unknown,
  params: unknown,
): Expansion | Refusal => INVARIANTS[id].expand(evidence, params);

/** The free-check invariants: a case made only of these is smoke-only, since they judge no behaviour of the app. */
const FREE: readonly InvariantId[] = ['no-5xx', 'no-console-error'];

/** Whether a case that stands only on `ids` is smoke-only (ADR 0020 section g). */
export const isSmokeOnly = (ids: readonly InvariantId[]): boolean =>
  ids.length > 0 && ids.every((id) => FREE.includes(id));
