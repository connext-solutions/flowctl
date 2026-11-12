import type { Assertion } from '../../src/flow/index.js';

/**
 * The flow every redaction test runs on the fixture's `/echo` page (T1.5): one secret input, typed into the password
 * field "Mật khẩu" and the text field "Ghi chú", then "Kiểm tra", so the page echoes it in its text, its address
 * bar's query, a request body and a `\u`-escaped response body. Two assertions hold; the others fail on purpose, on
 * values that hold the secret.
 */

/** The variable the secret input reads; the trust store allows it for `employee` in every test. */
export const SECRET_ENV = 'FLOWCTL_REDACTION_SECRET';

export const PASSWORD = { role: 'textbox', name: 'Mật khẩu' } as const;
export const NOTE = { role: 'textbox', name: 'Ghi chú' } as const;
export const CHECK = { role: 'button', name: 'Kiểm tra' } as const;

/** Assertions that hold once the form is sent. */
export const HOLDING: Assertion[] = [
  { network: { method: 'POST', url: '/api/echo', status: 422 } },
  { text: 'Đã nhận', within: { role: 'status' } },
  { url: '/echo?q=*' },
];

/**
 * Assertions that fail on what holds the secret: the field value, the page URL, the calls, the status text. A
 * result keeps the first failure's `got`, so each test puts first the one it wants quoted.
 */
export const FAILING = {
  value: { value: { locator: NOTE, equals: 'khác' } },
  url: { url: '/khac' },
  network: { network: { method: 'POST', url: '/api/echo', status: 418 } },
  text: { text: 'Không có', within: { role: 'status' } },
} as const;

/** The flow document named `name`, with the failing assertion `first` before the other failing ones. */
export const echoFlow = (
  name: string,
  first: keyof typeof FAILING = 'value',
): Record<string, unknown> & { name: string } => ({
  name,
  goal: 'Kiểm tra mật khẩu',
  profile: 'employee',
  start: '/echo',
  inputs: { pw: { env: SECRET_ENV } },
  steps: [
    { fill: PASSWORD, input: 'pw' },
    { fill: NOTE, input: 'pw' },
    { click: CHECK },
  ],
  assertions: [
    ...HOLDING,
    FAILING[first],
    ...Object.values(FAILING).filter((a) => a !== FAILING[first]),
  ],
});

/**
 * Runs `body` with {@link SECRET_ENV} set to `secret`, and unsets it afterwards.
 *
 * @example await withSecret(secret, () => replayFlow(cfg, flow, { browser, store }))
 */
export async function withSecret<T>(
  secret: string,
  body: () => Promise<T>,
): Promise<T> {
  process.env[SECRET_ENV] = secret;
  try {
    return await body();
  } finally {
    delete process.env[SECRET_ENV];
  }
}
