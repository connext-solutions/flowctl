import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigError, type LoadedConfig } from '../config.js';
import { RunError, errorMessage } from '../run/index.js';
import {
  buildRequest,
  parseDecision,
  type DecideInput,
  type Decision,
} from './protocol.js';

const RETRY_STATUSES = new Set([429, 503, 529]);
/** Host names of this machine, as `URL.hostname` gives them; plain `http:` to System 1 is allowed only to these. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const ATTEMPTS = 3;
/**
 * The largest System 1 answer read, in bytes. A real answer is a few KB (one choice per question); a larger one
 * is a misconfigured or hostile backend, and is not read to the end (#57).
 *
 * @internal
 */
export const MAX_ANSWER_BYTES = 1024 * 1024;

/**
 * The body of `res` as text, reading at most {@link MAX_ANSWER_BYTES} decoded bytes; `undefined` when the body
 * is larger (the rest is cancelled, never buffered). A UTF-8 BOM is dropped, as `res.text()` did.
 */
async function readCapped(res: Response): Promise<string | undefined> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
/**
 * Visible ASCII only. A key with a line break or control character makes fetch throw an error that quotes the
 * whole `Authorization` header, so such a key is refused before it can reach a message.
 */
const API_KEY_SHAPE = /^[\x21-\x7e]+$/;

/**
 * ` (content-type: text/html)` for an error message, or '' without a well-formed media type. Only a plain
 * `type/subtype` token is shown: any other value is attacker-chosen free text from a proxy or login page.
 * Response bodies are never put in messages.
 */
const contentType = (res: Response): string => {
  const type =
    (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  return /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,60}$/i.test(type)
    ? ` (content-type: ${type})`
    : '';
};

/**
 * The URL for an error message: origin and path only, without userinfo, query or fragment, so a credential in
 * `baseUrl` never reaches `error.hint`, `run.json`, the CLI or the MCP result.
 */
const displayUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
};

/**
 * An error message from `fetch`, with any `user:password@` removed from URLs it quotes (undici repeats the URL it
 * was given, credentials included).
 */
const scrub = (message: string): string =>
  message.replace(/\/\/[^\s/]*@/g, '//');

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

/**
 * The one HTTP client for `POST {baseUrl}/v1/systemone` (TypeSafe Jev, or any backend speaking the
 * same protocol).
 *
 * @remarks Retries 429/503/529 twice with backoff (0.5 s, 1 s). The API key is sent as a Bearer
 *   token and never appears in errors.
 * @see docs/adr/0003-single-systemone-client.md
 */
export class System1Client {
  /** The env {@link fromConfig} checked this client for; `undefined` for a client built directly (tests only). */
  readonly env: string | undefined;

  /**
   * @throws {ConfigError} for an API key that is not printable ASCII without spaces, or a `baseUrl` that does not
   *   parse, is not http(s), carries a user or password (fetch would quote either in its own errors), or is plain
   *   `http:` to a host other than this machine (the key and page text would travel unencrypted, issue #14).
   */
  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey: string;
      model?: string;
      timeoutMs?: number;
      env?: string;
    },
  ) {
    this.env = opts.env;
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
  }

  /**
   * Refuses a client that was not made by {@link fromConfig} for `env`, so a client checked for one env can never
   * be used on another (issue #15, ADR 0005).
   *
   * @throws {RunError} `system1_not_allowed`.
   */
  assertFor(env: string): void {
    if (this.env !== env)
      throw new RunError(
        'system1_not_allowed',
        `This System 1 client was allowed for env "${this.env ?? 'none'}", not "${env}"; System 1 runs only on an env in system1.allowedEnvs`,
      );
  }

  /**
   * The client for `env`, enforcing the data policy.
   *
   * @throws {RunError} `system1_not_allowed` when `env` is not in `system1.allowedEnvs` (ADR 0005), or the trust
   *   store does not allow the endpoint or the key variable (ADR 0024 section 1).
   * @throws {ConfigError} when the config has no `system1` section, or the API key variable is unset or malformed.
   */
  static fromConfig(
    cfg: LoadedConfig,
    env: string,
    vars: NodeJS.ProcessEnv = process.env,
  ): System1Client {
    const s1 = cfg.system1;
    if (s1 === undefined)
      throw new ConfigError(
        'flowctl.config.yaml has no system1 section; exploration and heal need one',
      );
    const refused = cfg.trustView?.system1Refused;
    if (refused !== undefined)
      throw new RunError('system1_not_allowed', refused);
    if (!s1.allowedEnvs.includes(env))
      throw new RunError(
        'system1_not_allowed',
        `System 1 is not allowed on env "${env}" (system1.allowedEnvs: ${s1.allowedEnvs.join(', ')}); only replay without heal runs there`,
      );
    const apiKey = vars[s1.apiKeyEnv];
    if (apiKey === undefined || apiKey === '')
      throw new ConfigError(`Set ${s1.apiKeyEnv} to use System 1`);
    return new System1Client({
      baseUrl: s1.baseUrl,
      apiKey,
      model: s1.model,
      env,
    });
  }

  /**
   * One decision: which operation, on which control, with which input.
   *
   * @param signal stops the request and any retry wait early: the run's wall-clock budget (ADR 0024 section 6).
   * @throws {RunError} `system1_unreachable` when the service cannot be reached, keeps failing,
   *   or answers something that does not fit the request, or `signal` aborted it.
   */
  async decide(input: DecideInput, signal?: AbortSignal): Promise<Decision> {
    const req = buildRequest(input, this.opts.model ?? 'jev-latest');
    const raw = await this.post(req.body, signal);
    try {
      return parseDecision(raw, req);
    } catch {
      throw new RunError(
        'system1_unreachable',
        'System 1 returned an answer that does not match the request; check that system1.baseUrl is a Jev backend and system1.model a model it serves',
      );
    }
  }

  private async post(body: unknown, stop?: AbortSignal): Promise<unknown> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/systemone`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            AbortSignal.timeout(this.opts.timeoutMs ?? 25_000),
            ...(stop === undefined ? [] : [stop]),
          ]),
        });
      } catch (e) {
        throw new RunError(
          'system1_unreachable',
          `Cannot reach System 1 at ${displayUrl(url)}: ${scrub(errorMessage(e))}`,
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
      let text: string | undefined;
      try {
        text = await readCapped(res);
      } catch (e) {
        throw new RunError(
          'system1_unreachable',
          `System 1 at ${displayUrl(url)} stopped while sending its answer: ${scrub(errorMessage(e))}`,
        );
      }
      if (!res.ok)
        throw new RunError(
          'system1_unreachable',
          `System 1 at ${displayUrl(url)} returned HTTP ${res.status}${contentType(res)}${statusHint(res.status)}`,
        );
      if (text === undefined)
        throw new RunError(
          'system1_unreachable',
          `System 1 at ${displayUrl(url)} sent an answer larger than ${MAX_ANSWER_BYTES} bytes; check that system1.baseUrl is a Jev backend`,
        );
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new RunError(
          'system1_unreachable',
          `System 1 at ${displayUrl(url)} answered HTTP ${res.status}${contentType(res)} with something that is not JSON (a proxy or login page?)`,
        );
      }
    }
  }
}
