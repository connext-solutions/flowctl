import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import type { EvidenceSummary, RunResult, TraceMode } from '../result.js';
import { ensureDirInside, writeFileNoFollow } from '../safe-fs.js';
import {
  MAX_CONSOLE_ERRORS,
  MAX_RESPONSE_READ,
  MAX_SUMMARY_REQUESTS,
  clip,
  listed,
  notKept,
} from './bounds.js';
import {
  API_TYPES,
  parseBody,
  redactEntry,
  fmtNet,
  type NetEntry,
} from './net-entry.js';
import { finalScreenshot } from './final-shot.js';
import { VideoRecorder } from './video.js';
import { redactResponse, redactText } from './redact.js';
import type { DecisionLogEntry } from './decision-log.js';

/** Names of run directories; pruning never touches anything else in `.runs`. */
export const RUN_ID = /^r_[0-9a-z]+$/;

export type { DecisionLogEntry } from './decision-log.js';

/**
 * Owns one run's directory `<runsDir>/<runId>/` and everything written into it.
 *
 * @remarks Layout (a contract users and tools read): `trace-<profile>.zip`, `final.png`,
 *   `network.json`, `console.json`, `decisions.jsonl` (explore and heal only), `appmap.json` (observe only), `run.json`.
 *   Lifecycle: {@link attach} every context before its first navigation → {@link decided} as
 *   System 1 answers → {@link collect} before the contexts close → {@link save} with the result.
 */
export class Evidence {
  readonly dir: string;
  private readonly runsDir: string;
  readonly network: NetEntry[] = [];
  /** Console and page errors as text, at most {@link MAX_CONSOLE_ERRORS}; see {@link droppedConsoleErrors}. */
  readonly consoleErrors: string[] = [];
  private dropped = 0;

  /** Console and page errors seen beyond {@link MAX_CONSOLE_ERRORS}: counted, not kept (they stay in the trace). */
  get droppedConsoleErrors(): number {
    return this.dropped;
  }
  private readonly entries: DecisionLogEntry[] = [];
  private readonly pending = new Set<Promise<void>>();
  private secrets: readonly string[] = [];
  /** The demo video of the run, when one was asked for (ADR 0032). */
  readonly video: VideoRecorder | undefined;

  /**
   * @param retention how many run directories {@link save} keeps under `runsDir`.
   * @param flowsPath the flows directory `runsDir` must stay inside.
   * @param videoTitle record a demo video titled so (ADR 0032); none when left out.
   * @throws {ConfigError} when `runsDir` (or a part of it) is a symlink or leaves `flowsPath`.
   */
  constructor(
    runsDir: string,
    runId: string,
    private readonly retention: number,
    flowsPath: string,
    readonly trace: TraceMode = 'safe',
    videoTitle?: string,
  ) {
    this.runsDir = ensureDirInside(runsDir, flowsPath, { gitignoreAll: true });
    this.dir = join(this.runsDir, runId);
    mkdirSync(this.dir);
    this.video =
      videoTitle === undefined
        ? undefined
        : new VideoRecorder(this.dir, videoTitle);
  }

  /**
   * Starts tracing and logging fetch/xhr, console errors and page errors for one profile's context.
   *
   * @remarks A request that got a response is logged once with its real status, even when its body
   *   read fails afterwards (navigation abort fires `requestfailed` too); only requests that never got
   *   a response are logged with status 0.
   */
  async attach(context: BrowserContext, profile: string): Promise<void> {
    const full = this.trace === 'full';
    await context.tracing.start({ screenshots: full, snapshots: full });
    await this.video?.attach(context);
    const answered = new WeakSet<Request>();
    context.on('response', (r) => {
      answered.add(r.request());
      this.track(this.onResponse(r, profile));
    });
    context.on('requestfailed', (r) => {
      if (!API_TYPES.has(r.resourceType()) || answered.has(r)) return;
      this.network.push({
        profile,
        method: r.method(),
        url: r.url(),
        status: 0,
        requestBody: parseBody(r.postData()),
        responseBody: r.failure()?.errorText,
      });
    });
    context.on('console', (m) => {
      if (m.type() === 'error') this.noteConsoleError(profile, m.text());
    });
    context.on('weberror', (e) =>
      this.noteConsoleError(profile, e.error().message),
    );
  }

  /**
   * The run's secret input values: masked as `***` in everything this module writes (`network.json`, the summary)
   * and in `final.png`, whose text fields are masked when there is any. Set before the first context is attached.
   *
   * @throws {RunError} `flow_invalid` when a video was asked for and there is a secret (ADR 0032).
   */
  useSecrets(secrets: readonly string[]): void {
    this.secrets = secrets.filter((s) => s !== '');
    this.video?.useSecrets(this.secrets);
  }

  /** Records one console or page error, clipped to {@link MAX_LINE}; beyond {@link MAX_CONSOLE_ERRORS} it is only counted. */
  noteConsoleError(profile: string, text: string): void {
    if (this.consoleErrors.length >= MAX_CONSOLE_ERRORS) this.dropped++;
    else
      this.consoleErrors.push(
        `[${profile}] ${clip(redactText(text, this.secrets))}`,
      );
  }

  /**
   * Records one System 1 decision: appended to `decisions.jsonl` at once, so a run that hangs or
   * crashes keeps its log, and kept in memory for reports.
   */
  decided(entry: DecisionLogEntry): void {
    this.entries.push(entry);
    appendFileSync(
      join(this.dir, 'decisions.jsonl'),
      `${JSON.stringify(entry)}\n`,
    );
  }

  /** Decisions recorded so far, in order. */
  get decisions(): readonly DecisionLogEntry[] {
    return this.entries;
  }

  /**
   * Waits for in-flight response bodies to be read, at most `timeoutMs` when given (a body that never ends must
   * not hold up an escalation).
   */
  async settle(timeoutMs?: number): Promise<void> {
    const all = Promise.allSettled(this.pending);
    if (timeoutMs === undefined) {
      await all;
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Writes traces, the final screenshot and the network/console logs; call before the contexts close.
   *
   * @param page the active page, screenshotted as `final.png` when still open.
   */
  async collect(
    sessions: [string, { context: BrowserContext }][],
    page?: Page,
  ): Promise<EvidenceSummary> {
    await this.settle();
    const screenshot =
      page === undefined || page.isClosed()
        ? undefined
        : await finalScreenshot(page, this.dir, this.secrets.length > 0);
    const traces: string[] = [];
    for (const [profile, s] of sessions) {
      const path = join(this.dir, `trace-${profile}.zip`);
      await s.context.tracing.stop({ path });
      traces.push(path);
    }
    this.flushLogs();
    return {
      dir: this.dir,
      traces,
      screenshot,
      trace: this.trace,
      network: listed(
        this.network
          .filter((e) => e.status === 0 || e.status >= 400)
          .map((e) => fmtNet(redactEntry(e, this.secrets))),
        MAX_SUMMARY_REQUESTS,
        'network.json',
      ),
      console: listed(
        this.consoleErrors,
        MAX_SUMMARY_REQUESTS,
        'console.json',
        this.droppedConsoleErrors,
      ),
    };
  }

  /**
   * Writes `network.json` and `console.json` as they are now. {@link collect} calls it at the end; an
   * exploration also calls it at every escalation, so a run abandoned there still leaves its network log
   * (task H0.1). Traces, `final.png` and `run.json` are written only when the run finishes.
   */
  flushLogs(): void {
    writeFileSync(
      join(this.dir, 'network.json'),
      JSON.stringify(
        this.network.map((e) => redactEntry(e, this.secrets)),
        null,
        2,
      ),
    );
    writeFileSync(
      join(this.dir, 'console.json'),
      JSON.stringify(
        this.dropped === 0
          ? this.consoleErrors
          : [...this.consoleErrors, notKept(this.dropped)],
        null,
        2,
      ),
    );
  }

  /**
   * Writes `run.json` and removes the oldest run directories beyond `retention`.
   *
   * @remarks Only real directories named like a run id ({@link RUN_ID}) are pruned; links, files
   *   and other folders a user keeps in `.runs` are left alone.
   */
  save(result: RunResult): void {
    this.artefact('run.json', JSON.stringify(result, null, 2));
    readdirSync(this.runsDir)
      .filter((name) => RUN_ID.test(name))
      .map((name) => ({
        path: join(this.runsDir, name),
        st: lstatSync(join(this.runsDir, name)),
      }))
      .filter((d) => d.st.isDirectory())
      .map((d) => ({ path: d.path, mtime: d.st.mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(this.retention)
      .forEach((d) => rmSync(d.path, { recursive: true, force: true }));
  }

  /** Writes one named file of the layout (`run.json`, or a crawl's `appmap.json`) and returns its path. */
  artefact(name: 'run.json' | 'appmap.json', text: string): string {
    const path = join(this.dir, name);
    writeFileNoFollow(path, text);
    return path;
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private async onResponse(r: Response, profile: string): Promise<void> {
    const req = r.request();
    if (!API_TYPES.has(req.resourceType())) return;
    const entry: NetEntry = {
      profile,
      method: req.method(),
      url: r.url(),
      status: r.status(),
      requestBody: parseBody(req.postData()),
    };
    this.network.push(entry);
    if (r.status() < 400) return;
    const declared = r.headers()['content-length'];
    const length = declared === undefined ? 0 : Number(declared);
    entry.responseBody =
      Number.isFinite(length) && length <= MAX_RESPONSE_READ
        ? clip(redactResponse(await r.text().catch(() => ''), this.secrets))
        : `(body not read: content-length ${clip(declared ?? '', 40)})`;
  }
}
