import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  APPROVALS_PAGE,
  HOME_PAGE,
  LAB_PAGE,
  SLOW_PAGE,
  LOGIN_PAGE,
  MESSAGES,
  REQUESTS_PAGE,
} from './pages.js';
import { validateLeaveRequest } from './validator.js';
import { crawlRoute, type CrawlBugMode } from './crawl.js';
import { guardRoute } from './guard-pages.js';

/**
 * Seeded bugs: each mode is a defect a correct flowctl run must report as `failed`.
 *
 * @remarks
 * - `save500`: POST returns 500.
 * - `notPersisted`: POST returns 201 but nothing is stored.
 * - `wrongBody`: the client sends type `OT` instead of `LEAVE`.
 * - `toastOnFail`: POST returns 500 but the UI shows the success toast.
 * - `noValidation`: an empty reason is submitted instead of blocked.
 * - `consoleError`: a JS error on page load.
 * - `list500`: the GET list returns 500.
 * - `wrongValueAfterReload`: the list returns the reason upper-cased.
 * - `approve403`: approve returns 403.
 * - `approveNoop`: approve returns 200 but the status never changes.
 * - `redirectWrong`: after a successful submit the address bar says `?saved=0` instead of `?saved=1`.
 * - `formNotReset`: after a successful submit the reason field keeps its text instead of clearing.
 * - `toastInList`: after a successful submit no toast is shown, and the success message lands in the list's status
 *   column instead; only a `text` assertion held `within` the toast region catches it (issue #47).
 * @see docs/adr/0004-deterministic-verdict.md
 */
export const BUG_MODES = [
  'save500',
  'notPersisted',
  'wrongBody',
  'toastOnFail',
  'noValidation',
  'consoleError',
  'list500',
  'wrongValueAfterReload',
  'approve403',
  'approveNoop',
  'redirectWrong',
  'formNotReset',
  'toastInList',
] as const;
export type BugMode = (typeof BUG_MODES)[number];

interface LeaveRequest {
  id: number;
  reason: string;
  amount: number;
  employee: string;
  type: string;
  status: 'PENDING' | 'APPROVED';
}

export interface Fixture {
  url: string;
  close(): Promise<void>;
}

const EMPLOYEES = ['Nguyễn Văn A', 'Nguyễn Văn B', 'Trần Thị C'];
const PAGES: Record<string, string> = {
  '/': HOME_PAGE,
  '/requests': REQUESTS_PAGE,
  '/approvals': APPROVALS_PAGE,
  '/lab': LAB_PAGE,
  '/slow': SLOW_PAGE,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Map<string, unknown>> {
  let data = '';
  for await (const chunk of req) data += String(chunk);
  const value: unknown = data ? JSON.parse(data) : {};
  return new Map(
    value !== null && typeof value === 'object' ? Object.entries(value) : [],
  );
}

/** The content type of each kind of `/map` and `/guard` answer. */
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  csv: 'text/csv; charset=utf-8',
} as const;

/**
 * Starts the fixture app on a random localhost port, with at most one seeded bug: a flow-class mode
 * ({@link BUG_MODES}) or a crawl-class mode (`CRAWL_BUG_MODES`, pages under `/map`).
 */
export async function startFixture(
  bug?: BugMode | CrawlBugMode,
): Promise<Fixture> {
  let store: LeaveRequest[] = [];
  let seq = 1;

  const page = (res: ServerResponse, html: string): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      html.replace(
        '</head>',
        `<script>window.BUG=${JSON.stringify(bug ?? '')}</script></head>`,
      ),
    );
  };

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    role: string,
  ): Promise<void> {
    if (req.method === 'GET' && url.pathname === '/api/employees') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return send(res, 200, {
        items: EMPLOYEES.filter((e) => e.toLowerCase().includes(q)),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/requests') {
      if (bug === 'list500') return send(res, 500, { message: 'boom' });
      const items = store.map((r) =>
        bug === 'wrongValueAfterReload'
          ? { ...r, reason: r.reason.toUpperCase() }
          : r,
      );
      return send(res, 200, { items });
    }
    if (req.method === 'POST' && url.pathname === '/api/requests') {
      const b = await readJson(req);
      if (bug === 'save500' || bug === 'toastOnFail')
        return send(res, 500, { message: 'boom' });
      const failed = validateLeaveRequest(b);
      if (failed !== undefined)
        return send(res, 400, {
          message: MESSAGES[failed.key] ?? failed.key,
          key: failed.key,
          field: failed.field,
        });
      const created: LeaveRequest = {
        id: seq++,
        reason: String(b.get('reason')),
        amount: Number(b.get('amount') ?? 0),
        employee: String(b.get('employee') ?? ''),
        type: String(b.get('type') ?? ''),
        status: 'PENDING',
      };
      if (bug !== 'notPersisted') store.push(created);
      return send(res, 201, created);
    }
    const approve = /^\/api\/requests\/(\d+)\/approve$/.exec(url.pathname);
    if (req.method === 'PATCH' && approve) {
      if (role !== 'manager' || bug === 'approve403')
        return send(res, 403, { message: 'forbidden' });
      const found = store.find((x) => x.id === Number(approve[1]));
      if (found === undefined) return send(res, 404, { message: 'not found' });
      if (bug !== 'approveNoop') found.status = 'APPROVED';
      return send(res, 200, found);
    }
    return send(res, 404, { message: 'not found' });
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const role = /(?:^|;\s*)role=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    if (req.method === 'POST' && url.pathname === '/api/__reset') {
      store = [];
      seq = 1;
      return send(res, 200, {});
    }
    if (url.pathname === '/login') {
      const as = url.searchParams.get('as');
      if (as !== null) {
        res.writeHead(302, {
          'set-cookie': `role=${as}; Path=/`,
          location: '/',
        });
        res.end();
        return;
      }
      return page(res, LOGIN_PAGE);
    }
    if (url.pathname.startsWith('/api/')) {
      if (role === undefined)
        return send(res, 401, { message: 'unauthorized' });
      return api(req, res, url, role);
    }
    if (role === undefined) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    const html = PAGES[url.pathname];
    if (html === undefined) {
      const crawl =
        crawlRoute(url.pathname, bug ?? '') ?? guardRoute(url.pathname);
      if (crawl === undefined) return send(res, 404, { message: 'not found' });
      if ('purge' in crawl) {
        store = [];
        return send(res, 200, { purged: true });
      }
      if ('location' in crawl) {
        res.writeHead(302, { location: crawl.location });
        res.end();
        return;
      }
      res.writeHead(crawl.status, {
        'content-type': CONTENT_TYPES[crawl.type],
        ...(crawl.filename === undefined
          ? {}
          : {
              'content-disposition': `attachment; filename="${crawl.filename}"`,
            }),
      });
      res.end(crawl.body);
      return;
    }
    const delay = Number(url.searchParams.get('delay') ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return page(res, html);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) =>
      send(res, 500, { message: String(e) }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fixture failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
