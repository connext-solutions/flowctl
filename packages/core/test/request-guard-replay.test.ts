import { describe, expect, it } from 'vitest';
import { RequestGuard } from '../src/run/index.js';

const APP = 'https://app.example';

/**
 * The request layer of a replay (ADR 0024 section 5, T1.3): on `shared`, `production` and `unknown` envs every
 * request that is not a `GET`, and every `GET` whose path holds a destructive word, is refused, because no stored
 * confirmation can authorise it yet; on `local` nothing is refused.
 */
describe('RequestGuard.forReplay', () => {
  it('refuses every method but GET, whatever its path or resource type', () => {
    for (const envClass of ['shared', 'production', 'unknown'] as const)
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'put'])
        for (const type of ['fetch', 'document', 'image', 'script'])
          expect(
            RequestGuard.forReplay(envClass, 'leave-submit').allows(
              method,
              `${APP}/api/requests`,
              type,
            ),
          ).toBe(false);
  });

  it('refuses a GET whose path holds a destructive word, and only for request types that can write', () => {
    const g = RequestGuard.forReplay('shared', 'clean-map');
    expect(
      g.allows('GET', `${APP}/assets/DeleteDialog-3f2a.js`, 'script'),
    ).toBe(true);
    expect(g.allows('GET', `${APP}/api/requests?q=xoá`, 'fetch')).toBe(true);
    expect(g.refusal).toBeUndefined();
    expect(g.allows('GET', `${APP}/map/purge`, 'fetch')).toBe(false);
    expect(g.refusal).toContain(`GET ${APP}/map/purge`);
  });

  it('adds the repo words', () => {
    const g = RequestGuard.forReplay('shared', 'f', ['nuke']);
    expect(g.allows('GET', `${APP}/items/nuke`, 'xhr')).toBe(false);
  });

  it('lets a plain GET through on every class, and everything through on local', () => {
    for (const envClass of ['shared', 'production', 'unknown'] as const)
      expect(
        RequestGuard.forReplay(envClass, 'f').allows(
          'GET',
          `${APP}/api/requests`,
          'fetch',
        ),
      ).toBe(true);
    const local = RequestGuard.forReplay('local', 'f');
    for (const method of ['POST', 'DELETE'])
      expect(local.allows(method, `${APP}/map/purge`, 'fetch')).toBe(true);
  });

  it('names the flow and the missing confirmation in the hint of a shared env, never the query', () => {
    const g = RequestGuard.forReplay('shared', 'leave-submit');
    g.allows('POST', `${APP}/api/requests?token=s3cret`, 'fetch');
    expect(g.refusal).toContain(`POST ${APP}/api/requests`);
    expect(g.refusal).toContain('destructiveConfirm');
    expect(g.refusal).toContain('"leave-submit"');
    expect(g.refusal).not.toContain('s3cret');
    expect(g.overrule({ status: 'passed' })).toMatchObject({
      status: 'error',
      error: { kind: 'destructive_blocked' },
    });
  });

  it('tells an unknown env to classify it, and never offers a confirmation for one', () => {
    const g = RequestGuard.forReplay('unknown', 'f');
    g.allows('POST', `${APP}/api/requests`, 'fetch');
    expect(g.refusal).toContain('flowctl trust add env');
    expect(g.refusal).not.toContain('destructiveConfirm');
  });

  it('is not lifted by the orchestrator', async () => {
    const g = RequestGuard.forReplay('shared', 'f');
    expect(
      await g.asOrchestrator(() =>
        Promise.resolve(g.allows('POST', `${APP}/api/requests`, 'fetch')),
      ),
    ).toBe(false);
  });
});
