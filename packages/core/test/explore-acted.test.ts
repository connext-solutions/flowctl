import { describe, expect, it } from 'vitest';
import { hasActed } from '../src/explore/loop.js';

/** When an exploration has acted, so that a verdict may pass (issue #47, ADR 0010 amendment). */
describe('hasActed', () => {
  it('is false before anything ran, and for waits and scrolls even when the page changed under them', () => {
    expect(hasActed([])).toBe(false);
    expect(
      hasActed([
        { op: 'WAIT', changed: true },
        { op: 'SCROLL_DOWN', changed: true },
        { op: 'SCROLL_UP', changed: true },
        { op: 'wait', changed: true },
        { op: 'scroll', changed: true },
      ]),
    ).toBe(false);
  });

  it('is false for a stale control, which was never acted on', () => {
    expect(hasActed([{ op: 'CLICK', control: 'stale', changed: true }])).toBe(
      false,
    );
  });

  it('is true for an action whose effect the fingerprint does not see (a click that only shows text)', () => {
    expect(
      hasActed([{ op: 'CLICK', control: '[3] button "Lưu"', changed: false }]),
    ).toBe(true);
  });

  it('is true once an action changed the page', () => {
    expect(
      hasActed([{ op: 'TYPE_TEXT', control: '[2] textbox', changed: true }]),
    ).toBe(true);
    expect(hasActed([{ op: 'goto', changed: true }])).toBe(true);
  });
});
