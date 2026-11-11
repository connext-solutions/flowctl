import type { Page } from 'playwright';
import { destructiveWord } from '../browser/index.js';
import type { By } from '../flow/index.js';
import type { RequestClass } from '../run/index.js';
import {
  isLoopback,
  openTrustStore,
  type TrustStore,
  trustedEnv,
} from '../trust/index.js';

/** Roles whose click acts: a field, cell, row or tab only selects or focuses, so it is never guarded. */
const ACTION_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'checkbox',
  'option',
]);

/** An action the guard stopped; the exploration escalates `destructive_action` with this message. */
export class DestructiveAction extends Error {}

/**
 * The guard's view of an env: a trust store class, or `unknown` for a non-loopback origin the store does not
 * list (guarded, and `allowDestructive` does not apply).
 */
export type GuardClass = RequestClass;

const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
};

/**
 * The class the guard uses for `origin`: `production` when the store lists a production origin on the same
 * host (any scheme or port, ADR 0024 section 2); else the store's class for an env on exactly this origin;
 * else `local` for loopback and `unknown` otherwise.
 *
 * @remarks Only the matching entries are verified, so one bad entry for another env does not stop every
 *   exploration. The default store is opened only for a non-loopback origin, so tests on a local fixture never
 *   read the owner's store.
 * @throws {TrustError} `trust_tampered` when a matching entry is not owner-signed.
 */
export function envClassFor(
  origin: string,
  store: TrustStore | undefined,
): GuardClass {
  const s = store ?? (isLoopback(origin) ? undefined : openTrustStore());
  if (s !== undefined) {
    const host = hostOf(origin);
    for (const [p, entry] of Object.entries(s.data.productionOrigins))
      if (hostOf(p) === host) {
        s.assertSigned(
          { id: p, kind: 'productionOrigins', value: {} },
          entry.sig,
        );
        return 'production';
      }
    for (const [name, e] of Object.entries(s.data.envs))
      if (e.origin === origin) {
        const verified = trustedEnv(s, name);
        if (verified !== undefined) return verified.class;
      }
  }
  return isLoopback(origin) ? 'local' : 'unknown';
}

/**
 * Stops destructive actions of an exploration on a `shared`, `production` or `unknown` env (ADR 0024 section 5,
 * interim): System 1 never takes one, and the orchestrator only on a `shared` env when the request set
 * `allowDestructive`. Replay of a saved flow is not guarded here: it only does what its reviewed file says.
 *
 * @remarks Only action roles are checked ({@link ACTION_ROLES}; an unknown role, e.g. a `testId`-only target,
 *   counts as one), by label. Not caught: an unnamed icon-only control, a `goto` to a GET that changes data,
 *   hover and drag; the request layer of section 5 comes with T1.3.
 */
export class ActionGuard {
  /**
   * @param extraWords the repo's `target.destructiveWords` (already narrowed by the effective configuration); they
   *   add to {@link DESTRUCTIVE_WORDS} and never remove one.
   */
  constructor(
    readonly envClass: GuardClass,
    private readonly allowOrchestrator: boolean,
    private readonly extraWords: readonly string[] = [],
  ) {}

  /** @throws {DestructiveAction} when acting on `label` (with `role`) is destructive and `by` may not do it here. */
  check(label: string, role: string | undefined, by: By): void {
    if (this.envClass === 'local') return;
    if (role !== undefined && !ACTION_ROLES.has(role)) return;
    const word = destructiveWord(label, this.extraWords);
    if (word === undefined) return;
    if (
      by === 'system2' &&
      this.allowOrchestrator &&
      this.envClass === 'shared'
    )
      return;
    throw new DestructiveAction(this.refusal(label, word, by));
  }

  /**
   * Checks what an Enter key would activate: the focused button or link itself, or else the first submit
   * button of the focused field's form.
   *
   * @throws {DestructiveAction} as {@link check}.
   */
  async checkEnter(page: Page, by: By): Promise<void> {
    if (this.envClass === 'local') return;
    const label = await page
      .evaluate(() => {
        const name = (b: Element): string =>
          b.getAttribute('aria-label') ??
          (b instanceof HTMLInputElement ? b.value : (b.textContent ?? ''));
        const el = document.activeElement;
        if (el === null) return '';
        if (
          el instanceof HTMLButtonElement ||
          el instanceof HTMLAnchorElement ||
          el.getAttribute('role') === 'button'
        )
          return name(el);
        const form =
          el instanceof HTMLInputElement || el instanceof HTMLSelectElement
            ? el.form
            : null;
        if (form === null) return '';
        const submit = [...form.elements].find(
          (b) =>
            (b instanceof HTMLButtonElement && b.type === 'submit') ||
            (b instanceof HTMLInputElement && b.type === 'submit'),
        );
        return submit === undefined ? '' : name(submit);
      })
      .catch(() => '');
    if (label !== '') this.check(label, undefined, by);
  }

  private refusal(label: string, word: string, by: By): string {
    const where = `on a ${this.envClass} env`;
    if (by === 'system1')
      return `System 1 chose "${label}", which looks destructive ("${word}") ${where}, and flowctl did not click it. Give a hint or finish; to take it yourself, start a new run with allowDestructive: true (shared envs only).`;
    if (this.envClass === 'shared')
      return `"${label}" looks destructive ("${word}") ${where}: start the exploration with allowDestructive: true to take it.`;
    return `"${label}" looks destructive ("${word}") ${where}: refused. allowDestructive applies only to an env the trust store classes shared.`;
  }
}
