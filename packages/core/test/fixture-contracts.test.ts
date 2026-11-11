import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  FIXTURE_CONTRACTS_DIR,
  type Fixture,
  LEAVE_REQUEST_RULES,
  MESSAGES,
  startFixture,
} from '@flowctl/fixture-app';

/**
 * The fixture app's contract artefacts agree with each other and with the app (T2.9): the OpenAPI numbers and message
 * keys equal the shared validator's, every key the pages and the validator use is in `i18n/vi.json`, and the server
 * answers a broken rule with that key. Contract readers (T4.10) rely on this agreement as their ground truth.
 */
const Field = z.object({
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  'x-message-keys': z.record(z.string(), z.string()).default({}),
});
const OpenApi = z.object({
  components: z.object({
    schemas: z.object({
      NewLeaveRequest: z.object({
        properties: z.object({ reason: Field, amount: Field }),
      }),
    }),
  }),
});

const read = (file: string): string =>
  readFileSync(join(FIXTURE_CONTRACTS_DIR, file), 'utf8');

const openapi = OpenApi.parse(parse(read('openapi.yaml')));
const fields = openapi.components.schemas.NewLeaveRequest.properties;
const vi = z
  .record(z.string(), z.string())
  .parse(JSON.parse(read('i18n/vi.json')));

describe('fixture-app contract artefacts (T2.9)', () => {
  it('OpenAPI repeats the validator numbers and message keys', () => {
    const r = LEAVE_REQUEST_RULES;
    expect(fields.reason).toMatchObject({
      minLength: 1,
      maxLength: r.reason.maxLength,
      'x-message-keys': {
        minLength: r.reason.requiredKey,
        maxLength: r.reason.maxLengthKey,
      },
    });
    expect(fields.amount).toMatchObject({
      minimum: r.amount.min,
      maximum: r.amount.max,
      'x-message-keys': { minimum: r.amount.key, maximum: r.amount.key },
    });
  });

  it('every message key the contract names is in i18n/vi.json, and the pages use that file', () => {
    const keys = [
      ...Object.values(fields.reason['x-message-keys']),
      ...Object.values(fields.amount['x-message-keys']),
    ];
    for (const k of keys) expect(vi[k], k).toBeTypeOf('string');
    expect(MESSAGES).toEqual(vi);
  });

  describe('the server answers with the same rules', () => {
    let app: Fixture;
    beforeAll(async () => {
      app = await startFixture();
    });
    afterAll(() => app.close());

    const post = async (
      body: Record<string, unknown>,
    ): Promise<{ status: number; key?: unknown }> => {
      const res = await fetch(`${app.url}/api/requests`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'role=employee',
        },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json();
      return {
        status: res.status,
        key: z.object({ key: z.unknown().optional() }).parse(json).key,
      };
    };
    const max = LEAVE_REQUEST_RULES.reason.maxLength;

    it.each([
      [{ reason: '', amount: 0 }, 'request.reason.required'],
      [{ reason: 'x'.repeat(max + 1), amount: 0 }, 'request.reason.tooLong'],
      [{ reason: 'ok', amount: -1 }, 'request.amount.invalid'],
      [{ reason: 'ok', amount: 1.5 }, 'request.amount.invalid'],
    ])('%j is refused with %s', async (body, key) => {
      expect(await post(body)).toEqual({ status: 400, key });
    });

    it('accepts a reason of exactly the maximum length', async () => {
      expect((await post({ reason: 'x'.repeat(max), amount: 0 })).status).toBe(
        201,
      );
    });
  });

  it('the reason field carries the same maxlength', async () => {
    const app = await startFixture();
    try {
      const html = await (
        await fetch(`${app.url}/requests`, {
          headers: { cookie: 'role=employee' },
        })
      ).text();
      expect(html).toContain(
        `<input id="reason" required maxlength="${LEAVE_REQUEST_RULES.reason.maxLength}">`,
      );
    } finally {
      await app.close();
    }
  });
});
