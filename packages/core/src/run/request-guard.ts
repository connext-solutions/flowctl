import { destructiveRequest } from '../browser/index.js';
import { RunError } from '../foundation/index.js';
import type { EnvClass } from '../trust/index.js';
import type { Outcome } from './outcome.js';

/** The class of the env a run is on, or `unknown` for a non-loopback origin the trust store does not list. */
export type RequestClass = EnvClass | 'unknown';

/**
 * The request types that can carry a write: a page or form navigation, fetch, XHR, a beacon or `ping`, an event
 * stream, and Chromium's `other`. Scripts, styles, images, fonts and media are not judged, so a bundle chunk named
 * after a component (`DeleteDialog-3f2a.js`) or an icon (`archive.svg`) never stops a run.
 */
const JUDGED_TYPES = new Set([
  'document',
  'fetch',
  'xhr',
  'ping',
  'eventsource',
  'other',
]);

/**
 * The request layer of the destructive-action guard (ADR 0024 section 5, interim, task T1.3): on a `shared`,
 * `production` or `unknown` env it refuses every request {@link destructiveRequest} names (any `DELETE`, a path with
 * a destructive word, a side-effecting `GET` included) before it leaves the browser. It is the line behind the label
 * guard of exploration, and it catches what labels miss: an icon-only control, a confirm dialog's "OK", a script.
 *
 * @remarks The run's scope guard calls {@link allows} for every request and redirect hop, and {@link assertClean}
 *   wherever it checks its own scope, so the run ends `error: destructive_blocked` at its next step or check, and
 *   {@link overrule} keeps any verdict off it. `allowDestructive` lifts the guard on a `shared` env only, and only
 *   while the orchestrator's own steps run ({@link asOrchestrator}): System 1's clicks stay guarded. A replay is
 *   guarded more strictly ({@link forReplay}): every non-GET is refused. On `production` the ADR blocks every non-GET;
 *   the exploration form blocks only what it names, so only {@link forReplay} may judge a production replay. Not
 *   caught in an exploration: a write whose path holds no destructive word (`PUT /items/12`), an action named in the
 *   body or query, a GraphQL mutation, a method override header or `_method` field, a WebSocket message, a
 *   destructive request from a script, style or image request type. Not caught in a replay: a destructive `GET`
 *   whose path holds no destructive word or which is sent as a script, style or image, and a WebSocket message.
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export class RequestGuard {
  private first: string | undefined;
  private orchestrating = false;

  /**
   * @param extraWords the repo's `target.destructiveWords`, already narrowed by the effective configuration.
   * @param replayOf the name of the flow a replay runs ({@link forReplay}); `undefined` for an exploration.
   */
  constructor(
    readonly envClass: RequestClass,
    private readonly allowDestructive: boolean,
    private readonly extraWords: readonly string[] = [],
    private readonly replayOf?: string,
  ) {}

  /**
   * The request layer of a replay of `flow` (ADR 0024 section 5): on a `shared`, `production` or `unknown` env it
   * refuses every request that is not a `GET`, of any resource type (`HEAD` included), and every `GET` that
   * {@link destructiveRequest} names, of a type in {@link JUDGED_TYPES}; on `local` it refuses nothing.
   *
   * @remarks A `destructiveConfirm` entry is the only thing that will let a replay write on `shared`; until stored
   *   confirmations exist, nothing does, and the hint says which confirmation is missing. Production hosts are
   *   already unreachable through the scope guard, which judges a request first; this layer is the second line.
   *   `allowDestructive` and {@link asOrchestrator} do not apply to a replay.
   */
  static forReplay(
    envClass: RequestClass,
    flow: string,
    extraWords: readonly string[] = [],
  ): RequestGuard {
    return new RequestGuard(envClass, false, extraWords, flow);
  }

  /**
   * Whether a request may be sent, noting a refusal when not.
   *
   * @param type the request's resource type (Playwright's, or CDP's in any case); one outside {@link JUDGED_TYPES}
   *   is always allowed.
   */
  allows(method: string, url: string, type: string): boolean {
    if (this.envClass === 'local') return true;
    if (this.replayOf !== undefined)
      return this.allowsReplay(method, url, type);
    if (
      this.envClass === 'shared' &&
      this.allowDestructive &&
      this.orchestrating
    )
      return true;
    if (!JUDGED_TYPES.has(type.toLowerCase())) return true;
    const word = destructiveRequest(method, url, this.extraWords);
    if (word === undefined) return true;
    this.first ??= `flowctl stopped ${method.toUpperCase()} ${pathOf(url)}, which looks destructive ("${word}") on a ${this.envClass} env. ${this.remedy()}`;
    return false;
  }

  private allowsReplay(method: string, url: string, type: string): boolean {
    const m = method.toUpperCase();
    const word =
      m !== 'GET'
        ? m
        : JUDGED_TYPES.has(type.toLowerCase())
          ? destructiveRequest(m, url, this.extraWords)
          : undefined;
    if (word === undefined) return true;
    const why =
      m === 'GET' ? `a GET that looks destructive ("${word}")` : 'a write';
    this.first ??= `flowctl stopped ${m} ${pathOf(url)}, ${why}, in a replay on a ${this.envClass} env. ${this.replayRemedy()}`;
    return false;
  }

  private replayRemedy(): string {
    if (this.envClass === 'unknown')
      return "The trust store does not list the env's origin, and a replay never writes on such an env: classify it with flowctl trust add env <env>.";
    if (this.envClass === 'production')
      return 'A replay never writes on production (ADR 0024 section 2a).';
    return `A replay writes on a shared env only when a destructiveConfirm entry in this machine's trust store authorises the request for flow "${this.replayOf ?? ''}", and none does: stored confirmations are not available yet (ADR 0024 section 5). Replay the flow on a local env.`;
  }

  /**
   * Runs `work` as the orchestrator's: with `allowDestructive` on a `shared` env, its requests pass. A request the
   * page sends after `work` ends is judged again.
   */
  async asOrchestrator<T>(work: () => Promise<T>): Promise<T> {
    this.orchestrating = true;
    try {
      return await work();
    } finally {
      this.orchestrating = false;
    }
  }

  /** The first refusal of the run, if any. */
  get refusal(): string | undefined {
    return this.first;
  }

  /** @throws {RunError} `destructive_blocked` naming the first request the guard stopped. */
  assertClean(): void {
    if (this.first !== undefined)
      throw new RunError('destructive_blocked', this.first);
  }

  /** `outcome`, or `error: destructive_blocked` when a request was refused and `outcome` is not already an error. */
  overrule(outcome: Outcome): Outcome {
    return this.first !== undefined && outcome.status !== 'error'
      ? {
          status: 'error',
          error: { kind: 'destructive_blocked', hint: this.first },
        }
      : outcome;
  }

  private remedy(): string {
    return this.envClass === 'shared'
      ? 'To send it, start the exploration again with allowDestructive: true and take that step yourself, on data the run created.'
      : 'allowDestructive applies only to an env the trust store classes shared.';
  }
}

/** The origin and path of `url`, without its query or fragment, which may carry tokens (capped at 200 characters). */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, 200);
  } catch {
    return url.slice(0, 80);
  }
}
