import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

/**
 * One scripted answer of the fake System 1.
 *
 * @remarks `target` labels are matched exactly against the `[<id>] <label>` element text the
 *   client sends in a target question, so a script reads like the controls a user sees.
 */
export interface FakeMove {
  op: string;
  target?: string;
  input?: string;
  /**
   * Probability of the chosen op, target and input (default 0.9). Raised to just above 1/n when
   * lower, so the choice stays the most likely of n options (a valid answer). Keep it ≥ 0.5 with
   * `second`.
   */
  p?: number;
  /** Runner-up operation and its target, used when the client rejects the first choice. */
  second?: { op: string; target?: string };
  /**
   * Answer `WAIT` (without using up this move) while the request offers no control labelled `target`,
   * as a person waits for an async list to render; at most `FAKE_TARGET_WAITS` times, then the move fails.
   */
  waitForTarget?: boolean;
}

/** How many `WAIT` answers a `waitForTarget` move gives before it fails like any missing label. */
export const FAKE_TARGET_WAITS = 10;

export interface FakeSystem1 {
  url: string;
  /** Bodies of every request received, in order, including refused ones. */
  requests: unknown[];
  close(): Promise<void>;
}

type Criteria = Record<string, unknown>;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function questionsOf(body: unknown): [string, Criteria][] {
  if (typeof body !== 'object' || body === null || !('questions' in body))
    return [];
  const qs = body.questions;
  if (typeof qs !== 'object' || qs === null) return [];
  return Object.entries(qs).flatMap(([name, q]): [string, Criteria][] =>
    typeof q === 'object' &&
    q !== null &&
    'criteria' in q &&
    typeof q.criteria === 'object' &&
    q.criteria !== null
      ? [[name, Object.fromEntries(Object.entries(q.criteria))]]
      : [],
  );
}

const elementOf = (c: unknown): string | undefined =>
  typeof c === 'object' &&
  c !== null &&
  'element' in c &&
  typeof c.element === 'string'
    ? c.element
    : undefined;

function spread(keys: string[], choice: string, p: number, second?: string) {
  const top = keys.length === 1 ? 1 : Math.max(p, 1 / keys.length + 0.01);
  const rest = 1 - top;
  const runnerUp =
    second !== undefined && second !== choice && keys.includes(second)
      ? second
      : undefined;
  const others = keys.filter((k) => k !== choice && k !== runnerUp);
  const secondShare =
    runnerUp === undefined ? 0 : others.length === 0 ? rest : rest * 0.6;
  const probabilities: Record<string, number> = { [choice]: top };
  if (runnerUp !== undefined) probabilities[runnerUp] = secondShare;
  for (const k of others)
    probabilities[k] = (rest - secondShare) / others.length;
  return { choice, confidence: top, probabilities };
}

function answer(body: unknown, move: FakeMove): Record<string, unknown> {
  const p = move.p ?? 0.9;
  const out: Record<string, unknown> = {};
  for (const [name, criteria] of questionsOf(body)) {
    const keys = Object.keys(criteria);
    if (name === 'operation') {
      if (!keys.includes(move.op))
        throw new Error(
          `fake System 1: ${move.op} not offered (${keys.join(', ')})`,
        );
      out[name] = spread(keys, move.op, p, move.second?.op);
      continue;
    }
    if (name === 'value') {
      if (move.input !== undefined && !keys.includes(move.input))
        throw new Error(`fake System 1: input "${move.input}" not offered`);
      const choice = move.input ?? keys[0];
      if (choice !== undefined) out[name] = spread(keys, choice, p);
      continue;
    }
    const op = name.replace(/_target$/, '').toUpperCase();
    const label =
      op === move.op
        ? move.target
        : op === move.second?.op
          ? move.second.target
          : undefined;
    const found =
      label === undefined
        ? keys[0]
        : keys.find((k) => elementOf(criteria[k]) === `[${k}] ${label}`);
    if (found === undefined)
      throw new Error(
        `fake System 1: no ${op} control labelled "${label ?? ''}"`,
      );
    out[name] = spread(keys, found, p);
  }
  return out;
}

/** True when the request offers a control labelled `move.target` for `move.op`. */
function offersTarget(body: unknown, move: FakeMove): boolean {
  const name = `${move.op.toLowerCase()}_target`;
  const criteria = questionsOf(body).find(([n]) => n === name)?.[1] ?? {};
  return Object.keys(criteria).some(
    (k) => elementOf(criteria[k]) === `[${k}] ${move.target ?? ''}`,
  );
}

/**
 * A scripted stand-in for TypeSafe's `POST /v1/systemone`: request n gets `moves[n]`, and the last
 * move repeats once the script runs out.
 *
 * @param opts.status answer every request with this HTTP status instead (unreachable/overloaded).
 * @remarks A move naming an operation, input or label the request does not offer is answered
 *   with HTTP 500 and the reason, so a broken script fails loudly instead of steering the run. A
 *   `waitForTarget` move is answered `WAIT` first while its label is missing, and the script does not
 *   advance on those answers.
 * @example
 * const s1 = await startFakeSystem1([
 *   { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
 *   { op: 'CLICK', target: 'Gửi' },
 * ]);
 */
export async function startFakeSystem1(
  moves: FakeMove[],
  opts: { status?: number } = {},
): Promise<FakeSystem1> {
  const requests: unknown[] = [];
  let cursor = 0;
  let waits = 0;

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/v1/systemone')
      return reply(res, 404, { message: 'not found' });
    if (!(req.headers.authorization ?? '').startsWith('Bearer '))
      return reply(res, 401, { message: 'missing key' });
    let data = '';
    for await (const chunk of req) data += String(chunk);
    const body: unknown = JSON.parse(data);
    requests.push(body);
    if (opts.status !== undefined)
      return reply(res, opts.status, { message: 'scripted status' });
    const move = moves[Math.min(cursor, moves.length - 1)];
    if (move === undefined) throw new Error('fake System 1: empty script');
    const wait =
      move.waitForTarget === true &&
      waits < FAKE_TARGET_WAITS &&
      !offersTarget(body, move);
    if (wait) waits++;
    else {
      cursor++;
      waits = 0;
    }
    return reply(res, 200, {
      answers: answer(body, wait ? { op: 'WAIT' } : move),
      model: 'fake-system1',
      usage: {},
    });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) =>
      reply(res, 500, { message: e instanceof Error ? e.message : String(e) }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fake System 1 failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
