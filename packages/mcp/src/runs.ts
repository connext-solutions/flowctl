import { type ExploreStop, FlowError } from '@flowctl/core';

/** How long one tool call waits for an exploration before it answers `running` (ADR 0012: about 60 s). */
export const WAIT_MS = 55_000;
/** An exploration nobody touched for this long is finished (teardown runs) and forgotten (ADR 0012). */
export const IDLE_MS = 10 * 60_000;
/** The most explorations one server keeps open at once; each holds browser contexts until it ends. */
export const MAX_RUNS = 4;

/** What a tool call gets back: where the exploration stopped, or that it is still working. */
export type Progress = ExploreStop | { runId: string; status: 'running' };

/** What {@link Runs} needs from an exploration; `Exploration` in the server, a stub in tests. */
export interface Explorable {
  readonly runId: string;
  finish(): Promise<ExploreStop>;
}

interface Entry<X> {
  x: X;
  busy: Promise<unknown> | undefined;
  last: ExploreStop | undefined;
  failure: unknown;
  touched: number;
}

const ended = (e: Entry<unknown>): boolean =>
  e.last !== undefined && e.last.status !== 'escalated';

/**
 * The explorations of one MCP server, keyed by `runId`. One operation runs per exploration at a time; a call
 * that finds it busy answers `running` and starts nothing.
 *
 * @remarks Every wait is bounded by {@link WAIT_MS}, and {@link sweep} finishes idle runs, so an abandoned
 *   exploration never keeps its browser contexts. Ended runs stay readable (for `flow_wait` and `flow_save`) until
 *   swept, but do not count against {@link MAX_RUNS}.
 */
export class Runs<X extends Explorable> {
  private readonly entries = new Map<string, Entry<X>>();
  private reserved = 0;

  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  /**
   * Reserves a slot for an exploration that is starting; call the returned release once it was added or failed.
   *
   * @throws {FlowError} when {@link MAX_RUNS} explorations are open or starting.
   */
  reserve(): () => void {
    const open = [...this.entries.values()].filter((e) => !ended(e)).length;
    if (open + this.reserved >= MAX_RUNS)
      throw new FlowError(
        `${MAX_RUNS} explorations are open; end one with flow_step { finish: true } or wait for it to finish.`,
      );
    this.reserved++;
    let done = false;
    return () => {
      if (!done) this.reserved--;
      done = true;
    };
  }

  add(x: X): void {
    this.entries.set(x.runId, {
      x,
      busy: undefined,
      last: undefined,
      failure: undefined,
      touched: Date.now(),
    });
  }

  /** Forgets `runId` (after a save); its run has already ended. */
  forget(runId: string): void {
    this.entries.delete(runId);
  }

  /**
   * Runs `op` on the exploration and waits up to {@link WAIT_MS} for it. While another operation is running,
   * `op` is not started and the answer is `running`: the caller waits with `flow_wait`, then sends it again.
   *
   * @throws {FlowError} for an unknown run; whatever an earlier operation of this run threw.
   */
  drive(runId: string, op: (x: X) => Promise<ExploreStop>): Promise<Progress> {
    const e = this.entry(runId);
    if (e.busy !== undefined)
      return Promise.resolve({ runId, status: 'running' });
    const p = this.hold(e, op(e.x)).then((stop) => {
      e.last = stop;
      return stop;
    });
    return this.within(runId, p);
  }

  /**
   * Runs `op` (a save) with the exploration locked, with no time bound.
   *
   * @throws {FlowError} for an unknown or busy run; whatever `op` throws.
   */
  async exclusive<T>(runId: string, op: (x: X) => Promise<T>): Promise<T> {
    const e = this.entry(runId);
    if (e.busy !== undefined)
      throw new FlowError(
        `Run ${runId} is still working; call flow_wait first.`,
      );
    return this.hold(e, op(e.x));
  }

  /**
   * Waits up to {@link WAIT_MS} for the running operation, or returns where the exploration last stopped.
   *
   * @throws {FlowError} for an unknown run or one never driven; whatever its last operation threw.
   */
  async wait(runId: string): Promise<Progress> {
    const e = this.entry(runId);
    if (e.busy !== undefined)
      return this.within(
        runId,
        e.busy.then(
          () => this.entry(runId).last ?? { runId, status: 'running' },
        ),
      );
    if (e.last === undefined)
      throw new FlowError(`Run ${runId} has no result yet; call flow_step.`);
    return e.last;
  }

  /** Finishes and forgets every idle exploration older than {@link IDLE_MS}; a failure goes to `onError`. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, e] of this.entries)
      if (e.busy === undefined && now - e.touched > IDLE_MS) {
        this.entries.delete(id);
        await e.x.finish().catch(this.onError);
      }
  }

  /** Finishes every exploration that is not busy (server shutdown); a busy one ends with its operation. */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      all.filter((e) => e.busy === undefined).map((e) => e.x.finish()),
    );
  }

  private entry(runId: string): Entry<X> {
    const e = this.entries.get(runId);
    if (e === undefined)
      throw new FlowError(
        `Unknown run ${runId}: it was saved or idle for over ${IDLE_MS / 60_000} minutes. Start a new one with flow_run.`,
      );
    if (e.failure !== undefined) throw e.failure;
    e.touched = Date.now();
    return e;
  }

  /** Marks `e` busy until `p` settles; a rejection is kept on the entry, reported, and ends the exploration. */
  private hold<T>(e: Entry<X>, p: Promise<T>): Promise<T> {
    const held = p.catch((err: unknown) => {
      e.failure = err;
      this.onError(err);
      void e.x.finish().catch(this.onError);
      throw err;
    });
    e.busy = held;
    void held
      .finally(() => {
        e.busy = undefined;
        e.touched = Date.now();
      })
      .catch(() => undefined);
    return held;
  }

  private async within(runId: string, p: Promise<Progress>): Promise<Progress> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Progress>((resolve) => {
      timer = setTimeout(() => resolve({ runId, status: 'running' }), WAIT_MS);
    });
    try {
      return await Promise.race([p, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
