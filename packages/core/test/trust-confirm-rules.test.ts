import { describe, expect, it } from 'vitest';
import { type ConfirmEntry, TrustStore } from '../src/trust/index.js';
import {
  CREATE,
  MUTATE,
  refusal,
  save,
  SESSION,
  store,
} from './confirm-fixture.js';

/** Every rule of a `destructiveConfirm` entry is refused at write (ADR 0024 section 5 and its amendments). */
describe('destructiveConfirm rules', () => {
  const BAD: [string, ConfirmEntry[]][] = [
    [
      'a production env',
      [{ ...CREATE, env: 'prod', origin: 'https://erp.example.com' }],
    ],
    ['an env the store does not list', [{ ...CREATE, env: 'qa' }]],
    [
      'an origin other than the env',
      [{ ...CREATE, origin: 'https://other.example.com' }],
    ],
    ['expires more than 90 days ahead', [{ ...CREATE, expires: '2027-02-12' }]],
    ['expires that is not a date', [{ ...CREATE, expires: '2026-02-30' }]],
    ['a * in the template', [{ ...CREATE, template: '/api/*' }]],
    ['{slug}', [{ ...MUTATE, template: '/api/items/{slug}' }, CREATE]],
    [
      'a placeholder glued to text',
      [{ ...MUTATE, template: '/api/items/{int}.json' }, CREATE],
    ],
    ['a trailing slash', [{ ...CREATE, template: '/api/items/' }]],
    ['a first placeholder', [{ ...MUTATE, template: '/{int}/items' }, CREATE]],
    [
      'a placeholder in a create template',
      [{ ...CREATE, template: '/api/{int}/items' }],
    ],
    ['a dotted body path', [{ ...CREATE, bodyKeys: ['name', '/code'] }]],
    [
      'the pointer segment -',
      [{ ...CREATE, bodyKeys: ['/name', '/code', '/lines/-'] }],
    ],
    ['a nameField outside bodyKeys', [{ ...CREATE, nameField: '/title' }]],
    ['a prefix other than QA-', [{ ...CREATE, prefix: 'TEST-' }]],
    ['a * in idFrom', [{ ...CREATE, idFrom: 'body:/ids/*' }]],
    [
      'idFrom that is neither body nor Location',
      [{ ...CREATE, idFrom: 'query:id' }],
    ],
    [
      'a cleanup template of another resource',
      [
        {
          ...CREATE,
          cleanup: { ...CREATE.cleanup, template: '/api/users/{int}' },
        },
      ],
    ],
    [
      'a cleanup template with two ids',
      [
        {
          ...CREATE,
          cleanup: { ...CREATE.cleanup, template: '/api/items/{int}/{int}' },
        },
      ],
    ],
    [
      'a mutate without its path position',
      [CREATE, { ...MUTATE, idPositions: ['body:/name'] }],
    ],
    ['a mutate without a create entry', [{ ...MUTATE, ledgerFrom: 'nothing' }]],
    [
      'a mutate on another collection',
      [CREATE, { ...MUTATE, template: '/api/users/{int}' }],
    ],
    [
      'a session template with a placeholder',
      [{ ...SESSION, template: '/api/login/{int}' }],
    ],
    ['a logout session', [{ ...SESSION, template: '/api/logout' }]],
    [
      'an override header',
      [{ ...SESSION, headers: ['x-http-method-override'] }],
    ],
    ['no contentType on a POST', [{ ...SESSION, contentType: undefined }]],
  ];

  it.each(BAD)('refuses %s at write and writes nothing', (_what, entries) => {
    const s = store();
    expect(refusal(() => save(s, entries))).toMatch(/^trust_entry_invalid/);
    expect(TrustStore.open(s.dir).data.destructiveConfirm).toEqual([]);
  });
});
