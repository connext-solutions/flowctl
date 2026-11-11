import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import {
  OperationSchema,
  SpecRegistry,
  type Operation,
  type SpecProvider,
} from '../src/spec/index.js';

const op = (over: Partial<Operation> = {}): Operation => ({
  id: 'leave-submit',
  title: 'Gửi đơn nghỉ',
  actor: 'employee',
  preconditions: [],
  steps: ['Mở màn Đơn từ', 'Bấm "Gửi"'],
  expected: [
    {
      text: 'Hiện thông báo "Đã gửi đơn"',
      value: 'Đã gửi đơn',
      ref: {
        doc: 'leave/submit.md',
        section: 'Kết quả',
        lines: [12, 12],
        revision: 'abc123',
      },
      context: {
        operationId: 'leave-submit',
        operationTitle: 'Gửi đơn nghỉ',
        headings: ['Đơn từ', 'Gửi đơn nghỉ'],
        leadIn: null,
      },
    },
  ],
  location: { provider: 'markdown', ref: 'leave/submit.md' },
  signatureRef: null,
  ...over,
});

const provider = (
  name: string,
  ops: unknown[],
  extra: Partial<SpecProvider> = {},
): SpecProvider => ({
  name,
  operations: () => Promise.resolve(ops),
  resolve: () => Promise.resolve(null),
  ...extra,
});

describe('Operation schema (ADR 0023)', () => {
  it('accepts a full operation and refuses unknown keys', () => {
    expect(OperationSchema.parse(op())).toEqual(op());
    expect(() => OperationSchema.parse({ ...op(), extra: 1 })).toThrow();
  });

  it('requires a context on every expected item and NFC text in the signed fields', () => {
    const noContext = { ...op().expected[0], context: undefined };
    expect(() =>
      OperationSchema.parse({ ...op(), expected: [noContext] }),
    ).toThrow();
    const nfd = 'Nghi\u0300'.normalize('NFD');
    expect(() =>
      OperationSchema.parse(
        op({ location: { provider: 'markdown', ref: `${nfd}.md` } }),
      ),
    ).toThrow(/NFC/);
  });

  it('refuses a provider name that is not a flowctl name', () => {
    expect(() =>
      OperationSchema.parse(op({ location: { provider: 'a/b', ref: 'x' } })),
    ).toThrow();
  });
});

describe('SpecRegistry: explicit registration, untrusted output', () => {
  it('returns validated operations of a registered provider', async () => {
    const r = new SpecRegistry();
    r.register(provider('markdown', [op()]));
    expect(r.names()).toEqual(['markdown']);
    expect(await r.operations('markdown')).toEqual([op()]);
  });

  it('refuses a bad or duplicate provider name, and an unknown one at use', async () => {
    const r = new SpecRegistry();
    r.register(provider('markdown', []));
    expect(() => r.register(provider('markdown', []))).toThrow(ConfigError);
    expect(() => r.register(provider('Bad Name', []))).toThrow(ConfigError);
    await expect(r.operations('gherkin')).rejects.toThrow(ConfigError);
  });

  it('refuses output that names another provider or breaks the schema', async () => {
    const r = new SpecRegistry();
    r.register(
      provider('markdown', [
        op({ location: { provider: 'gherkin', ref: 'x.feature' } }),
      ]),
    );
    await expect(r.operations('markdown')).rejects.toThrow(/gherkin/);
    const s = new SpecRegistry();
    s.register(provider('markdown', [{ id: 'x', __proto__: { polluted: 1 } }]));
    await expect(s.operations('markdown')).rejects.toThrow();
  });

  it('reads a signature set only through the provider, and treats a failure as none', async () => {
    const r = new SpecRegistry();
    r.register(
      provider('markdown', [], {
        signatures: () => Promise.reject(new Error('boom')),
      }),
    );
    r.register(provider('gherkin', []));
    expect(await r.signatures('markdown', 'a.md.sig')).toBeNull();
    expect(await r.signatures('gherkin', 'a.sig')).toBeNull();
  });
});
