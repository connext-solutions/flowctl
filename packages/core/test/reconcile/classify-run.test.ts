import { describe, expect, it } from 'vitest';
import type { ErrorKind } from '../../src/result.js';
import { classifyFailure } from '../../src/reconcile/index.js';
import { appMap } from '../derive/build.js';
import { classes, run } from './classify-build.js';

describe('classifyFailure: errored and passed runs', () => {
  it.each<ErrorKind>([
    'app_unreachable',
    'profile_expired',
    'budget_exceeded',
    'setup_failed',
  ])('%s is environment, high, citing run.json', (kind) => {
    const c = classifyFailure({
      result: run({ status: 'error', error: { kind, hint: 'start the app' } }),
    });
    expect(c).toMatchObject({
      class: 'environment',
      confidence: 'high',
      candidates: [],
    });
    expect(c.basis[0]?.evidence).toEqual([
      { source: 'run', pointer: '/error/kind', text: kind },
      { source: 'run', pointer: '/error/hint', text: 'start the app' },
    ]);
  });

  it.each<ErrorKind>([
    'scope_violation',
    'flow_invalid',
    'internal',
    'destructive_blocked',
  ])('%s is not classed: unknown, no hits', (kind) => {
    const c = classifyFailure({
      result: run({ status: 'error', error: { kind, hint: 'x' } }),
    });
    expect(c).toMatchObject({
      class: 'unknown',
      confidence: null,
      hits: [],
      candidates: [],
    });
    expect(c.notes).toEqual([`error kind ${kind} is not classed`]);
  });

  it('an errored run ignores its network evidence', () => {
    const result = run({
      status: 'error',
      error: { kind: 'internal', hint: 'crash' },
      evidence: {
        dir: '/d',
        traces: [],
        network: ['500 GET http://127.0.0.1:4000/api/x'],
        console: [],
      },
    });
    expect(classifyFailure({ result }).hits).toEqual([]);
  });

  it('a passed run is unknown with a note', () => {
    const c = classifyFailure({ result: run({ status: 'passed' }) });
    expect(c).toMatchObject({
      class: 'unknown',
      hits: [],
      notes: ['the run passed: nothing to classify'],
    });
  });
});

describe('classifyFailure: network rules', () => {
  const withCalls = (network: string[]) =>
    run({
      failed: { assertion: { noConsoleErrors: true }, got: 'x' },
      evidence: { dir: '/d', traces: [], network, console: [] },
    });

  it('a gateway status is environment, medium, citing the network line', () => {
    const c = classifyFailure({
      result: withCalls(['503 GET http://127.0.0.1:4000/api/items {"e":1}']),
    });
    expect(c).toMatchObject({ class: 'environment', confidence: 'medium' });
    expect(c.basis[0]?.evidence).toEqual([
      {
        source: 'run',
        pointer: '/evidence/network/0',
        text: '503 GET http://127.0.0.1:4000/api/items',
      },
    ]);
  });

  it('status 0 is environment, low; the more specific gateway rule is the basis when both fire', () => {
    expect(
      classes({ result: withCalls(['0 GET http://127.0.0.1:4000/a']) }),
    ).toEqual({
      class: 'environment',
      confidence: 'low',
      rules: ['no-response'],
    });
    const c = classifyFailure({
      result: withCalls(['0 GET http://h/a', '502 GET http://h/b']),
    });
    expect(c.basis.map((h) => h.rule)).toEqual(['gateway-status']);
    expect(c.hits.map((h) => h.rule)).toEqual([
      'gateway-status',
      'no-response',
    ]);
  });

  it('a 5xx on the app origin is a product bug; unknown origins lower it; another origin is environment', () => {
    const line = ['500 POST http://127.0.0.1:4000/api/orders'];
    expect(classes({ result: withCalls(line), map: appMap([]) })).toEqual({
      class: 'product_bug',
      confidence: 'medium',
      rules: ['server-error'],
    });
    expect(classes({ result: withCalls(line) })).toMatchObject({
      class: 'product_bug',
      confidence: 'low',
    });
    expect(
      classes({ result: withCalls(line), origins: ['https://app.example'] }),
    ).toEqual({
      class: 'environment',
      confidence: 'low',
      rules: ['foreign-server-error'],
    });
  });

  it('skips lines that do not parse, such as the "and N more" line', () => {
    const c = classifyFailure({
      result: withCalls(['… and 3 more in network.json', '404 GET http://h/x']),
    });
    expect(c).toMatchObject({ class: 'unknown', hits: [] });
  });
});
