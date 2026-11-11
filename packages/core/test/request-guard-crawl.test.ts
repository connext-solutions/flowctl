import { describe, expect, it } from 'vitest';
import { RequestGuard } from '../src/run/index.js';

const APP = 'http://127.0.0.1:5173';

/**
 * The request layer of a crawl (ADR 0024 section 5: the guard covers the crawler in every env class; ADR 0033): only
 * reads pass, on a local env too, and a refusal is an observation of the open page, not the end of the run.
 */
describe('RequestGuard.forCrawl', () => {
  it('refuses every write and every destructive GET on every env class, local included', () => {
    for (const envClass of [
      'local',
      'shared',
      'production',
      'unknown',
    ] as const) {
      const g = RequestGuard.forCrawl(envClass, []);
      expect(g.allows('GET', `${APP}/api/requests`, 'fetch')).toBe(true);
      expect(g.allows('HEAD', `${APP}/api/requests`, 'fetch')).toBe(true);
      expect(g.allows('OPTIONS', `${APP}/api/requests`, 'fetch')).toBe(true);
      expect(g.allows('POST', `${APP}/api/requests`, 'fetch')).toBe(false);
      expect(g.allows('PUT', `${APP}/api/requests/1`, 'xhr')).toBe(false);
      expect(g.allows('POST', `${APP}/search`, 'document')).toBe(false);
      expect(g.allows('GET', `${APP}/map/purge`, 'document')).toBe(false);
    }
  });

  it('adds the repo words and still ignores scripts and images', () => {
    const g = RequestGuard.forCrawl('local', ['nuke']);
    expect(g.allows('GET', `${APP}/api/nuke`, 'fetch')).toBe(false);
    expect(g.allows('GET', `${APP}/assets/DeleteDialog.js`, 'script')).toBe(
      true,
    );
  });

  it('keeps a refusal as an observation the crawl takes per page, never as the run end', () => {
    const g = RequestGuard.forCrawl('local', []);
    expect(g.allows('POST', `${APP}/api/requests`, 'fetch')).toBe(false);
    expect(g.observes('scope_violation')).toBe(true);
    expect(() => g.assertClean()).not.toThrow();
    expect(g.overrule({ status: 'passed' })).toEqual({ status: 'passed' });
    expect(g.takeRefusals()).toEqual([
      'destructive_blocked',
      'scope_violation',
    ]);
    expect(g.takeRefusals()).toEqual([]);
  });

  it('checks the method first: a write of a type the guard does not judge (a CSP report, a script) is refused too', () => {
    const g = RequestGuard.forCrawl('local', []);
    expect(g.allows('POST', `${APP}/csp-report`, 'csp_report')).toBe(false);
    expect(g.allows('POST', `${APP}/assets/app.js`, 'script')).toBe(false);
    expect(g.allows('PUT', `${APP}/logo.png`, 'image')).toBe(false);
    expect(g.allows('GET', `${APP}/assets/app.js`, 'script')).toBe(true);
    expect(g.allows('GET', `${APP}/archive.svg`, 'image')).toBe(true);
    expect(g.takeRefusals()).toEqual(['destructive_blocked']);
    expect(() => g.assertClean()).not.toThrow();
  });

  it('ends the run on a refusal it only detected, after the request was sent', () => {
    const g = RequestGuard.forCrawl('local', []);
    expect(g.allows('POST', `${APP}/api/requests`, 'fetch', false)).toBe(false);
    expect(g.takeRefusals()).toEqual([]);
    expect(() => g.assertClean()).toThrow(
      expect.objectContaining({ kind: 'destructive_blocked' }),
    );
    expect(g.overrule({ status: 'passed' }).status).toBe('error');
  });

  it('is a crawl guard only from forCrawl', () => {
    expect(RequestGuard.forCrawl('shared', []).crawling).toBe(true);
    expect(new RequestGuard('shared', false).crawling).toBe(false);
  });

  it('is not a crawl guard otherwise: observes nothing', () => {
    const g = new RequestGuard('shared', false);
    expect(g.observes('scope_violation')).toBe(false);
    expect(g.takeRefusals()).toEqual([]);
  });
});
