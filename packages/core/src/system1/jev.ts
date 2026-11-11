import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigError } from '../config.js';
import { RunError, errorMessage } from '../run/index.js';
import {
  buildRequest,
  parseDecision,
  type DecideInput,
  type Decision,
} from './protocol.js';
import {
  BodyStopped,
  MAX_ANSWER_BYTES,
  NotLoopback,
  postOnce,
} from './wire.js';

const RETRY_STATUSES = new Set([429, 503, 529]);
/** Host names of this machine, as `URL.hostname` gives them; plain `http:` to System 1 is allowed only to these. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const ATTEMPTS = 3;
/**
 * Visible ASCII only. A key with a line break or control character makes the HTTP layer throw an error that quotes
 * the whole `Authorization` header, so such a key is refused before it can reach a message.
 */
const API_KEY_SHAPE = /^[\x21-\x7e]+$/;
/** Error codes of a certificate the bundled roots do not accept. */
const CERT_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)/;

/**
 * ` (content-type: text/html)` for an error message, or '' without a well-formed media type. Only a plain
 * `type/subtype` token is shown: any other value is attacker-chosen free text from a proxy or login page.
 * Response bodies are never put in messages.
 */
const contentType = (raw: string): string => {
  const type = raw.split(';')[0]?.trim() ?? '';
  return /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,60}$/i.test(type)
    ? ` (content-type: ${type})`
    : '';
};

/**
 * The URL for an error message: origin and path only, without userinfo, query or fragment, so a credential in
 * `baseUrl` never reaches `error.hint`, `run.json`, the CLI or the MCP result.
 */
const displayUrl = (url: URL): string => `${url.origin}${url.pathname}`;

/** An error message with any `user:password@` removed from URLs it quotes. */
const scrub = (message: string): string =>
  message.replace(/\/\/[^\s/]*@/g, '//');

/** The reason a request could not be sent, with a hint for a certificate the bundled roots refuse. */
const reason = (e: unknown): string => {
  const code =
    e instanceof Error && 'code' in e && typeof e.code === 'string'
      ? e.code
      : '';
  return CERT_ERROR.test(code)
    ? `${scrub(errorMessage(e))} (flowctl checks System 1 certificates against the public roots bundled with Node only; NODE_TLS_REJECT_UNAUTHORIZED and NODE_EXTRA_CA_CERTS are not used)`
    : scrub(errorMessage(e));
};

/**
 * What to do next for an HTTP error from System 1, chosen by status only (the body is never shown), so the
 * message stays actionable without echoing untrusted text.
 */
const statusHint = (status: number): string =>
  status === 401 || status === 403
    ? '; check the API key in the variable named by system1.apiKeyEnv'
    : status === 404
      ? '; check system1.baseUrl (it must point at a /v1/systemone backend)'
      : status === 429 || status >= 500
        ? '; System 1 is overloaded or down, try again later'
        : '';

/** What a {@link JevDriver} is built from; `apiKey` is the value of the variable named by `system1.apiKeyEnv`. */
export interface JevOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * The adapter for `POST {baseUrl}/v1/systemone` (TypeSafe Jev, or any backend speaking the same protocol).
 *
 * @remarks Built only by the factory in `client.ts` (`createDriver`; `scripts/check-arch.mjs` fails a construction
 *   anywhere else in `src/`); an instance made any other way is refused by every entry point. Retries 429/503/529
 *   twice with backoff (0.5 s, 1 s). The API key is sent as a Bearer token and never appears in errors. The
 *   transport rules of ADR 0022 contract 7 live in `wire.ts`.
 * @see docs/adr/0022-driver-seam.md
 */
export class JevDriver {
  readonly id = 'jev';
  readonly #url: URL;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;

  /**
   * @throws {ConfigError} for an API key that is not printable ASCII without spaces, or a `baseUrl` that does not
   *   parse, is not http(s), carries a user or password (the HTTP layer would quote either in its own errors), or is
   *   plain `http:` to a host other than this machine (the key and page text would travel unencrypted, issue #14).
   */
  constructor(opts: JevOptions) {
    if (!API_KEY_SHAPE.test(opts.apiKey))
      throw new ConfigError(
        'The System 1 API key must be printable ASCII without spaces or line breaks (check the variable for a pasted newline)',
      );
    let base: URL | undefined;
    try {
      base = new URL(opts.baseUrl);
    } catch {
      base = undefined;
    }
    if (
      base === undefined ||
      (base.protocol !== 'http:' && base.protocol !== 'https:') ||
      base.username !== '' ||
      base.password !== ''
    )
      throw new ConfigError(
        'system1.baseUrl must be a plain http(s) URL with no user or password in it',
      );
    if (base.protocol === 'http:' && !LOOPBACK.has(base.hostname))
      throw new ConfigError(
        'system1.baseUrl is plain http to another machine, which would send the API key and page text unencrypted; use https (http is only for a System 1 on this machine)',
      );
    this.#url = new URL(`${opts.baseUrl.replace(/\/$/, '')}/v1/systemone`);
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? 'jev-latest';
    this.#timeoutMs = opts.timeoutMs ?? 25_000;
  }

  /**
   * One decision: which operation, on which control, with which input.
   *
   * @param signal stops the request and any retry wait early: the run's wall-clock budget (ADR 0024 section 6).
   * @throws {RunError} `system1_unreachable` when the service cannot be reached, keeps failing, redirects, or
   *   answers something that does not fit the request, or `signal` aborted it; `system1_not_allowed` when plain
   *   http connected to an address that is not this machine.
   */
  async decide(input: DecideInput, signal?: AbortSignal): Promise<Decision> {
    const req = buildRequest(input, this.#model);
    const raw = await this.#post(JSON.stringify(req.body), signal);
    try {
      return parseDecision(raw, req);
    } catch {
      throw new RunError(
        'system1_unreachable',
        'System 1 returned an answer that does not match the request; check that system1.baseUrl is a Jev backend and system1.model a model it serves',
      );
    }
  }

  async #post(payload: string, stop?: AbortSignal): Promise<unknown> {
    const url = this.#url;
    const shown = displayUrl(url);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      authorization: `Bearer ${this.#apiKey}`,
    };
    for (let attempt = 1; ; attempt++) {
      const signal = AbortSignal.any([
        AbortSignal.timeout(this.#timeoutMs),
        ...(stop === undefined ? [] : [stop]),
      ]);
      let res: Awaited<ReturnType<typeof postOnce>>;
      try {
        res = await postOnce(url, headers, payload, signal);
      } catch (e) {
        if (e instanceof NotLoopback)
          throw new RunError(
            'system1_not_allowed',
            `System 1 at ${shown} is plain http, and the connection reached an address that is not this machine; use https`,
          );
        if (e instanceof BodyStopped)
          throw new RunError(
            'system1_unreachable',
            `System 1 at ${shown} stopped while sending its answer: ${scrub(e.message)}`,
          );
        throw new RunError(
          'system1_unreachable',
          `Cannot reach System 1 at ${shown}: ${reason(e)}`,
        );
      }
      if (RETRY_STATUSES.has(res.status) && attempt < ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1), undefined, {
          signal: stop,
        }).catch((e: unknown) => {
          throw new RunError(
            'system1_unreachable',
            `System 1 retry stopped: ${scrub(errorMessage(e))}`,
          );
        });
        continue;
      }
      if (res.status >= 300 && res.status < 400)
        throw new RunError(
          'system1_unreachable',
          `System 1 at ${shown} answered with a redirect (HTTP ${res.status}); redirects are not followed, point system1.baseUrl at the backend itself`,
        );
      if (res.status < 200 || res.status >= 300)
        throw new RunError(
          'system1_unreachable',
          `System 1 at ${shown} returned HTTP ${res.status}${contentType(res.contentType)}${statusHint(res.status)}`,
        );
      if (res.text === undefined)
        throw new RunError(
          'system1_unreachable',
          `System 1 at ${shown} sent an answer larger than ${MAX_ANSWER_BYTES} bytes; check that system1.baseUrl is a Jev backend`,
        );
      try {
        return JSON.parse(res.text) as unknown;
      } catch {
        throw new RunError(
          'system1_unreachable',
          `System 1 at ${shown} answered HTTP ${res.status}${contentType(res.contentType)} with something that is not JSON (a proxy or login page?)`,
        );
      }
    }
  }
}
