/**
 * Pages for the crawler's accuracy tests (task T2.6), under `/map`, separate from the leave-request pages so the
 * existing flows and snapshots do not change. `/map` is the crawl start.
 *
 * @remarks The decoys are always on: a crawl that stays in scope must never follow them. The crawl-class bugs are
 *   switched on one at a time like the other seeded bugs, and are caught by the free checks of T2.4 (no 4xx/5xx,
 *   no console error, no broken link, no unreachable page), not by a flow assertion, so they are not in `BUG_MODES`.
 *   `/map/report` always loads its summary from `/map/api/summary` (a fetch), which answers 200 on the clean app.
 */

/**
 * Seeded bugs a crawl must find on its own.
 *
 * @remarks
 * - `brokenLink`: the "Trợ giúp" link on `/map` points to `/map/missing`, which answers 404.
 * - `page500`: `/map/report` answers 500.
 * - `pageConsoleError`: `/map/report` logs a console error.
 * - `pageNoAnswer`: the "Trợ giúp" link on `/map` points to `/map/down`, where the server destroys the socket
 *   (status 0, nothing refused). `/map` also sends a beacon (a write the crawl refuses) when it is left, so that late
 *   refusal lands on `/map/down` and must not explain its missing answer.
 * - `call500`: the summary fetch of `/map/report` answers 500.
 * - `call404`: the summary fetch of `/map/report` answers 404. No free check judges a 4xx call (ADR 0033 amendment
 *   2026-11-12), so this mode is a documented non-detection, not a caught bug.
 */
export const CRAWL_BUG_MODES = [
  'brokenLink',
  'page500',
  'pageConsoleError',
  'pageNoAnswer',
  'call500',
  'call404',
] as const;
export type CrawlBugMode = (typeof CRAWL_BUG_MODES)[number];

/**
 * Links and controls a crawl must not follow or activate, each with why. The `/map` page renders exactly these,
 * so a crawler test can assert that none of them was visited.
 */
export const DECOYS = {
  offScope: '/admin/settings',
  popup: '/map/popup',
  protocolRelative: '//evil.example/x',
  crossOriginForm: 'https://evil.example/submit',
  javascript: 'javascript:alert(1)',
  data: 'data:text/html,<p>x</p>',
  redirectHop: '/map/hop',
  subdomainSuffix: 'http://localhost.evil.example/',
  doubleEncoded: '/map/%252e%252e/admin',
  hashRoute: '/map#/admin/settings',
  serviceWorker: '/map/sw.js',
  sideEffectGet: '/map/purge',
  iconDestructive: 'button 🗑 and an svg-only button, no aria-label',
} as const;

const head = (title: string): string =>
  `<!doctype html><html lang="vi"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head>`;

/** Where the "Trợ giúp" link of `/map` points under `bug`. */
const helpHref = (bug: string): string =>
  bug === 'brokenLink'
    ? '/map/missing'
    : bug === 'pageNoAnswer'
      ? '/map/down'
      : '/map/help';

const mapPage = (bug: string): string => `${head('Sơ đồ')}<body>
<h1>Sơ đồ</h1>
<nav>
  <a href="/requests">Đơn từ</a>
  <a href="/approvals">Phê duyệt</a>
  <a href="/map/report">Báo cáo</a>
  <a href="${helpHref(bug)}">Trợ giúp</a>
</nav>
<section aria-label="Không đi theo">
  <a href="${DECOYS.offScope}">Cài đặt hệ thống</a>
  <a href="${DECOYS.popup}" target="_blank">Mở cửa sổ mới</a>
  <button type="button" onclick="window.open('${DECOYS.popup}')">Mở popup</button>
  <a href="${DECOYS.protocolRelative}">Trang ngoài</a>
  <form action="${DECOYS.crossOriginForm}" method="post"><input name="q" aria-label="Từ khoá ngoài"><button>Gửi ra ngoài</button></form>
  <a href="${DECOYS.javascript}">Chạy script</a>
  <a href="${DECOYS.data}">Dữ liệu nhúng</a>
  <a href="${DECOYS.redirectHop}">Chuyển hướng</a>
  <a href="${DECOYS.subdomainSuffix}">Tên miền giống</a>
  <a href="${DECOYS.doubleEncoded}">Đường dẫn mã hoá</a>
  <a href="${DECOYS.hashRoute}">Cài đặt (hash)</a>
  <a href="${DECOYS.sideEffectGet}">Xoá tất cả</a>
  <button type="button" onclick="fetch('${DECOYS.sideEffectGet}')">🗑</button>
  <button type="button" onclick="fetch('${DECOYS.sideEffectGet}')"><svg width="12" height="12"><path d="M1 1h10v10H1z"/></svg></button>
</section>
<script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('${DECOYS.serviceWorker}').catch(() => {});</script>
${bug === 'pageNoAnswer' ? "<script>addEventListener('beforeunload', () => navigator.sendBeacon('/map/api/left', 'map'));</script>" : ''}
</body></html>`;

const reportPage = (bug: string): string => `${head('Báo cáo')}<body>
<h1>Báo cáo</h1><a href="/map">Sơ đồ</a><p id="summary">Đang tải…</p>
<script>fetch('/map/api/summary').then((r) => r.ok ? r.json() : { total: '—' }).then((d) => { document.getElementById('summary').textContent = 'Tổng: ' + d.total; });</script>
<script>${bug === 'pageConsoleError' ? "console.error('seeded bug: report failed to render');" : ''}</script>
</body></html>`;

const helpPage = `${head('Trợ giúp')}<body><h1>Trợ giúp</h1><a href="/map">Sơ đồ</a></body></html>`;

const popupPage = `${head('Popup')}<body><h1>Popup</h1></body></html>`;

/**
 * What the server sends for a `/map` or `/guard` request: a page, a redirect, a script, JSON, a file (sent as an
 * attachment named `filename`), `destroy` (the socket is closed with no answer), or `undefined` (not such a path).
 */
export type CrawlAnswer =
  | {
      status: number;
      type: 'html' | 'js' | 'csv' | 'json';
      body: string;
      filename?: string;
    }
  | { status: 302; location: string }
  | { purge: true }
  | { destroy: true };

/**
 * The answer for `pathname` under `/map`, given the active bug mode (or `''`). `/map/purge` is a side-effecting
 * GET: the caller wipes the request store when it gets `{ purge: true }`, and destroys the socket on
 * `{ destroy: true }`.
 */
export function crawlRoute(
  pathname: string,
  bug: string,
): CrawlAnswer | undefined {
  switch (pathname) {
    case '/map':
      return { status: 200, type: 'html', body: mapPage(bug) };
    case '/map/report':
      return bug === 'page500'
        ? {
            status: 500,
            type: 'html',
            body: `${head('Lỗi')}<body><h1>Lỗi máy chủ</h1></body></html>`,
          }
        : { status: 200, type: 'html', body: reportPage(bug) };
    case '/map/help':
      return { status: 200, type: 'html', body: helpPage };
    case '/map/popup':
      return { status: 200, type: 'html', body: popupPage };
    case '/map/hop':
      return { status: 302, location: 'https://evil.example/landing' };
    case '/map/sw.js':
      return {
        status: 200,
        type: 'js',
        body: "self.addEventListener('fetch', () => {});",
      };
    case '/map/purge':
      return { purge: true };
    case '/map/down':
      return bug === 'pageNoAnswer' ? { destroy: true } : undefined;
    case '/map/api/summary':
      return {
        status: bug === 'call500' ? 500 : bug === 'call404' ? 404 : 200,
        type: 'json',
        body: JSON.stringify({ total: 3 }),
      };
    default:
      return undefined;
  }
}
