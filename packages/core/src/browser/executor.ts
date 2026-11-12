import type { Locator, Page } from 'playwright';
import type { Loc, Step, TemplatedValue } from '../flow/index.js';
import { FlowError, StepError, readFixture } from '../foundation/index.js';
import { describeLoc, notFoundMessage, toPlaywright } from './locator.js';
import { FILL_SETTLE_MS, fillSecret } from './secret-fill.js';

export { StepError } from '../foundation/index.js';
export type { StepErrorKind } from '../foundation/index.js';

export interface ExecOptions {
  testIdAttribute: string;
  /** How long to wait for a target to become visible. */
  timeout: number;
  /** The flows directory: `upload` files are read from its `fixtures/` folder (ADR 0024 section 1a). */
  flowsRoot: string;
  /** The run's secret input values: a `fill` of one is typed without leaving the value in the trace (ADR 0030). */
  secrets?: readonly string[];
}

/** A step {@link perform} runs on a page: profile switches and navigation belong to the run. */
export type Performable = Exclude<Step, { kind: 'as' | 'goto' }>;

/** What an action needs to run on the active page of a run (`RunSession.ctx()`). */
export interface ActContext {
  page: Page;
  values: Record<string, string>;
  exec: ExecOptions;
  /** Values the run expanded from templates (the uid, templated inputs), so recorded names can be templated back. */
  templated: TemplatedValue[];
}

/**
 * Narrows a locator to visible elements, so a hidden copy (a responsive layout's mobile twin) neither
 * makes a match ambiguous nor hides the visible one.
 */
export const visibleOnly = (l: Locator): Locator => l.filter({ visible: true });

/**
 * Waits for the target, then insists on exactly one visible match: replay never guesses between
 * candidates.
 *
 * @throws {StepError} `not_found` when no visible element appears within `timeout`, `ambiguous`
 *   when more than one visible element matches.
 */
export async function unique(
  page: Page,
  loc: Loc,
  o: Pick<ExecOptions, 'testIdAttribute' | 'timeout'>,
): Promise<Locator> {
  const l = visibleOnly(toPlaywright(page, loc, o.testIdAttribute));
  try {
    await l.first().waitFor({ state: 'visible', timeout: o.timeout });
  } catch {
    throw new StepError('not_found', notFoundMessage(loc));
  }
  const n = await l.count();
  if (n > 1)
    throw new StepError(
      'ambiguous',
      `${describeLoc(loc)} matched ${n} elements`,
    );
  return l;
}

async function fillVerified(
  page: Page,
  l: Locator,
  value: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await l.fill(value);
    if (value === '') return;
    await page.waitForTimeout(FILL_SETTLE_MS);
    if ((await l.inputValue()) !== '') return;
  }
  throw new StepError('action_failed', 'field was still empty after 3 fills');
}

/**
 * Performs one recorded step on `page`, then waits for `domcontentloaded`.
 *
 * @remarks
 * - Targets must match exactly one visible element ({@link unique}).
 * - `fill` re-fills until the value survives a re-render (fields that re-mount or reformat).
 * - `fill` on a `combobox` types key by key with a delay: search comboboxes often react to key
 *   events only and drop characters when text is inserted at once.
 * - `select` uses the native option on `<select>`, otherwise opens the combobox and clicks the
 *   option named like the value (Radix-style).
 * @throws {StepError} `not_found` / `ambiguous` for the target, `action_failed` for a missing input
 *   value or any Playwright failure (first line of its message).
 * @throws {FlowError} for an `upload` path that is not a plain file under `fixtures/` in the flows directory.
 * @see docs/adr/0009-locator-strategy.md
 */
export async function perform(
  page: Page,
  step: Performable,
  values: Record<string, string>,
  o: ExecOptions,
): Promise<void> {
  const value = (key: string): string => {
    const v = values[key];
    if (v === undefined)
      throw new StepError('action_failed', `no value for input "${key}"`);
    return v;
  };
  try {
    switch (step.kind) {
      case 'click':
        await (await unique(page, step.target, o)).click();
        break;
      case 'check':
        await (await unique(page, step.target, o)).check();
        break;
      case 'hover':
        await (await unique(page, step.target, o)).hover();
        break;
      case 'fill': {
        const v = value(step.input);
        const l = await unique(page, step.target, o);
        if (v !== '' && o.secrets?.includes(v) === true) {
          await fillSecret(page, l, v, o.timeout);
        } else if (step.target.role === 'combobox') {
          await l.click();
          await l.press('ControlOrMeta+a');
          await l.press('Delete');
          await l.pressSequentially(v, { delay: 80 });
        } else {
          await fillVerified(page, l, v);
        }
        break;
      }
      case 'select': {
        const v = value(step.input);
        if (v !== '' && o.secrets?.includes(v) === true)
          throw new FlowError(
            `input "${step.input}" is a secret and cannot be selected: an option label is page text and lands in the trace`,
          );
        const l = await unique(page, step.target, o);
        if ((await l.evaluate((e) => e.tagName)) === 'SELECT') {
          await l.selectOption({ label: v });
        } else {
          await l.click();
          await (await unique(page, { role: 'option', name: v }, o)).click();
        }
        break;
      }
      case 'press':
        await page.keyboard.press(step.key);
        break;
      case 'reload':
        await page.reload();
        break;
      case 'wait':
        await page.waitForTimeout(step.ms);
        break;
      case 'scroll':
        await page.mouse.wheel(0, step.dy);
        break;
      case 'upload':
        await (
          await unique(page, step.target, o)
        ).setInputFiles(readFixture(o.flowsRoot, step.file));
        break;
      case 'drag':
        await (
          await unique(page, step.target, o)
        ).dragTo(await unique(page, step.to, o));
        break;
    }
    await page.waitForLoadState('domcontentloaded');
  } catch (e) {
    if (e instanceof StepError || e instanceof FlowError) throw e;
    const first =
      e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
    throw new StepError('action_failed', `${step.kind}: ${first}`);
  }
}
