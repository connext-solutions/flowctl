import { describe, expect, it } from 'vitest';
import { redactBody, redactResponse, redactText } from '../src/run/index.js';

/** Redaction of evidence and messages (ADR 0030, issues #10, #11, #18). */
describe('redactBody', () => {
  it('masks credential fields at any depth and in any spelling, keeps the rest', () => {
    expect(
      redactBody(
        {
          user: 'an',
          password: 'p1',
          Api_Key: 'k',
          nested: { accessToken: 't', 'x-otp': '123', list: [{ pin: '9' }] },
          amount: 2,
        },
        [],
      ),
    ).toEqual({
      user: 'an',
      password: '***',
      Api_Key: '***',
      nested: { accessToken: '***', 'x-otp': '***', list: [{ pin: '***' }] },
      amount: 2,
    });
  });

  it('masks a secret input value wherever it appears, also inside other strings', () => {
    expect(
      redactBody({ note: 'code s3cr3t here', other: ['s3cr3t'] }, ['s3cr3t']),
    ).toEqual({ note: 'code *** here', other: ['***'] });
  });

  it('masks credential fields of a form-encoded or a raw string body', () => {
    expect(redactBody('user=an&password=p1&pwd=x', [])).toBe(
      'user=an&password=***&pwd=***',
    );
    expect(redactBody('plain s3cr3t', ['s3cr3t'])).toBe('plain ***');
    expect(redactBody(undefined, ['x'])).toBeUndefined();
  });

  it('masks every value below a credential name but keeps its shape, and keeps names that only look alike', () => {
    expect(
      redactBody(
        {
          session: { id: 'x', shift: 'Sáng' },
          workSession: 'Sáng',
          shipping: 'nhanh',
          option: 'A',
          isSecret: true,
          pin: 1234,
        },
        [],
      ),
    ).toEqual({
      session: { id: '***', shift: '***' },
      workSession: 'Sáng',
      shipping: 'nhanh',
      option: 'A',
      isSecret: true,
      pin: '***',
    });
  });

  it('does not change the value it was given', () => {
    const body = { password: 'p1' };
    redactBody(body, []);
    expect(body.password).toBe('p1');
  });
});

describe('redactText', () => {
  it.each([
    ['{"token":"abc","ok":1}', '{"token":"***","ok":1}'],
    ['password=hunter2 user=an', 'password=*** user=an'],
    ['Authorization: Bearer eyJhbGc.x.y', 'Authorization: ***'],
    ['curl -H "Cookie: sid=abc; theme=dark"', 'curl -H "Cookie: ***"'],
    ['API_KEY=sk-live-123 done', 'API_KEY=*** done'],
    ['set secret: abc', 'set secret: ***'],
  ])('masks %j', (text, masked) => {
    expect(redactText(text, [])).toBe(masked);
  });

  it.each([
    ['{"otp":123456,"a":2}', '{"otp":"***","a":2}'],
    ['...,"token":"eyJhbGciOi', '...,"token":"***"'],
    ['a=1; password=x; b=2', 'a=1; password=***; b=2'],
    ['Set-Cookie: sid=abc; Path=/; HttpOnly', 'Set-Cookie: ***'],
  ])(
    'masks %j (numbers, a cut value, a pair list, a cookie header)',
    (text, masked) => {
      expect(redactText(text, [])).toBe(masked);
    },
  );

  it('masks a credential inside escaped JSON, keeping the escaping', () => {
    expect(redactText(String.raw`{\"token\":\"x\",\"b\":1}`, [])).toBe(
      String.raw`{\"token\":\"***\",\"b\":1}`,
    );
  });

  it.each([
    [String.raw`{"password":"ab\"cdLEAK"}`, '{"password":"***"}'],
    ["password='abc def' ok", "password='***' ok"],
    ['Cookie:\nNEXTLINE visible', 'Cookie:\nNEXTLINE visible'],
  ])(
    'masks %j as a whole value, never part of it, and stops at the line',
    (text, masked) => {
      expect(redactText(text, [])).toBe(masked);
    },
  );

  it('masks every leaf of a nested credential in a body', () => {
    expect(
      redactBody(
        { token: { access: 'eyJ', n: 2, ok: true }, credentials: ['abc'] },
        [],
      ),
    ).toEqual({
      token: { access: '***', n: '***', ok: true },
      credentials: ['***'],
    });
  });

  it('keeps ordinary text and masks secret values too', () => {
    expect(redactText('Đơn đã lưu, mã s3cr3t', ['s3cr3t'])).toBe(
      'Đơn đã lưu, mã ***',
    );
    expect(redactText('the token field is required', [])).toBe(
      'the token field is required',
    );
  });
});

describe('redactResponse', () => {
  it('walks a JSON body, numbers and nested fields included', () => {
    expect(
      JSON.parse(
        redactResponse(
          '{"data":{"otp":123456,"user":{"apiKey":"k"}},"n":1}',
          [],
        ),
      ),
    ).toEqual({ data: { otp: '***', user: { apiKey: '***' } }, n: 1 });
  });

  it('falls back to text redaction for a body that is not JSON', () => {
    expect(redactResponse('error: token=abc', [])).toBe('error: token=***');
  });
});

describe('pageText (escalation text) redaction', () => {
  it('masks a credential pair without hiding the rest of the page text', async () => {
    const { pageText } = await import('../src/explore/page-text.js');
    expect(pageText('Cookie: sid=1\nTên: An token=abc Lưu', [], 200)).toBe(
      'Cookie: *** Tên: An token=*** Lưu',
    );
  });
});
