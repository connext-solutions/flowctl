import { describe, expect, it } from 'vitest';
import { destructiveRequest } from '../src/browser/index.js';
import { RequestGuard } from '../src/run/index.js';

const APP = 'https://app.example';

/** The request layer of the destructive-action guard (ADR 0024 section 5, T1.3 chunk 1). */
describe('destructiveRequest', () => {
  it.each([
    ['DELETE', '/api/requests/12', 'DELETE'],
    ['delete', '/api/requests/12', 'DELETE'],
    ['GET', '/items/12/delete', 'delete'],
    ['GET', '/map/purge', 'purge'],
    ['PATCH', '/api/requests/1/approve', 'approve'],
    ['POST', '/api/orders/7/refund', 'refund'],
    ['POST', '/api/bulkDeleteItems', 'delete'],
    ['POST', '/api/remove_all', 'remove'],
    ['POST', '/api/don/xo%C3%A1', 'xoá'],
    ['GET', '/api/%64elete', 'delete'],
  ])('refuses %s %s ("%s")', (method, path, word) => {
    expect(destructiveRequest(method, `${APP}${path}`)).toBe(word);
  });

  it.each([
    ['GET', '/api/requests'],
    ['POST', '/api/requests'],
    ['PUT', '/api/requests/12'],
    ['PATCH', '/api/profile'],
    ['GET', '/api/approvals'],
    ['POST', '/api/resend'],
    ['HEAD', '/items/12/delete'],
    ['OPTIONS', '/items/12/delete'],
    ['GET', '/search?q=delete'],
  ])('lets %s %s through: no destructive token in its path', (method, path) => {
    expect(destructiveRequest(method, `${APP}${path}`)).toBeUndefined();
  });

  it('adds the repo words to the core list', () => {
    expect(
      destructiveRequest('POST', `${APP}/api/leave/finalise`, ['finalise']),
    ).toBe('finalise');
  });

  it('refuses a URL it cannot read', () => {
    expect(destructiveRequest('POST', 'not a url')).toBe('unreadable URL');
  });
});

describe('RequestGuard', () => {
  const approve = `${APP}/api/requests/1/approve`;
  const kindOf = (f: () => void): string | undefined => {
    try {
      f();
    } catch (e) {
      return e instanceof Error && 'kind' in e ? String(e.kind) : String(e);
    }
    return undefined;
  };

  it('lets everything through on a local env', () => {
    expect(
      new RequestGuard('local', false).allows('DELETE', approve, 'fetch'),
    ).toBe(true);
  });

  it('refuses on shared, production and unknown envs, keeps the first refusal, and throws it', () => {
    for (const envClass of ['shared', 'production', 'unknown'] as const) {
      const g = new RequestGuard(envClass, false);
      expect(g.allows('PATCH', `${approve}?token=s3cret`, 'xhr')).toBe(false);
      expect(g.allows('DELETE', `${APP}/api/x/2`, 'fetch')).toBe(false);
      expect(g.refusal).toContain(`PATCH ${approve}`);
      expect(g.refusal).not.toContain('s3cret');
      expect(kindOf(() => g.assertClean())).toBe('destructive_blocked');
    }
  });

  it('does not judge scripts, styles, images or fonts, so a chunk or an icon never stops a run', () => {
    const g = new RequestGuard('shared', false);
    for (const [path, type] of [
      ['/assets/DeleteDialog-3f2a.js', 'script'],
      ['/assets/archive.svg', 'image'],
      ['/assets/remove.css', 'stylesheet'],
      ['/fonts/void.woff2', 'font'],
    ] as const)
      expect(g.allows('GET', `${APP}${path}`, type)).toBe(true);
    expect(g.refusal).toBeUndefined();
    expect(g.allows('GET', `${APP}/map/purge`, 'Document')).toBe(false);
  });

  it('lets only the orchestrator steps through on a shared env with allowDestructive, never elsewhere', async () => {
    const g = new RequestGuard('shared', true);
    expect(g.allows('PATCH', approve, 'fetch')).toBe(false);
    const g2 = new RequestGuard('shared', true);
    expect(
      await g2.asOrchestrator(() =>
        Promise.resolve(g2.allows('PATCH', approve, 'fetch')),
      ),
    ).toBe(true);
    expect(g2.allows('PATCH', approve, 'fetch')).toBe(false);
    for (const envClass of ['production', 'unknown'] as const) {
      const g3 = new RequestGuard(envClass, true);
      expect(
        await g3.asOrchestrator(() =>
          Promise.resolve(g3.allows('PATCH', approve, 'fetch')),
        ),
      ).toBe(false);
    }
  });

  it('overrules a verdict into destructive_blocked, never an earlier error', () => {
    const g = new RequestGuard('shared', false);
    expect(g.overrule({ status: 'failed' })).toEqual({ status: 'failed' });
    g.allows('PATCH', approve, 'fetch');
    expect(g.overrule({ status: 'passed' })).toMatchObject({
      status: 'error',
      error: { kind: 'destructive_blocked' },
    });
    const earlier = {
      status: 'error' as const,
      error: { kind: 'scope_violation' as const, hint: 'x' },
    };
    expect(g.overrule(earlier)).toBe(earlier);
  });
});
