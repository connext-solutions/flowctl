import type { CrawlAnswer } from './crawl.js';

/**
 * Pages for the scope guard's browser tests in core (ADR 0024 section 3, rules 6 and 7), under `/guard`, apart from
 * `/map` so the crawl decoys stay exactly `DECOYS` and nothing links here.
 *
 * @remarks `/guard/downloads` offers an export in scope (a navigation answered with an attachment, and a
 *   `download` link to it), the same export through a `download` link to another origin, and an export the page
 *   builds itself (`data:`). `/guard/frames` shows a frame in scope and inserts, on a click, a frame on another
 *   origin, a `data:` frame and a frame in scope that then moves to a denied hash route.
 */
export const GUARD_PAGES = {
  downloads: '/guard/downloads',
  frames: '/guard/frames',
  /** The export: a CSV answered as an attachment. */
  file: '/guard/files/report.csv',
  /** Another origin the run's scope never holds. */
  offScopeFile: 'https://evil.example/report.csv',
  offScopeFrame: 'https://evil.example/frame',
  frameInScope: '/guard/inner',
} as const;

const head = (title: string): string =>
  `<!doctype html><html lang="vi"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head>`;

const addFrame = (src: string): string =>
  `document.body.append(Object.assign(document.createElement('iframe'), { src: '${src}', title: 'Khung thêm' }))`;

const downloadsPage = `${head('Tải xuống')}<body>
<h1>Tải xuống</h1>
<a href="${GUARD_PAGES.file}">Xuất báo cáo</a>
<a href="${GUARD_PAGES.file}" download>Tải báo cáo</a>
<a href="${GUARD_PAGES.offScopeFile}" download>Tải từ nơi khác</a>
<a href="data:text/csv,ma%2Cten%0A1%2CAn" download="bao-cao.csv">Tải bản nháp</a>
</body></html>`;

const framesPage = `${head('Khung')}<body>
<h1>Khung</h1>
<iframe src="${GUARD_PAGES.frameInScope}" title="Khung trong"></iframe>
<button type="button" onclick="${addFrame(GUARD_PAGES.offScopeFrame)}">Khung ngoài</button>
<button type="button" onclick="${addFrame('data:text/html,<p>x</p>')}">Khung dữ liệu</button>
<button type="button" onclick="document.querySelector('iframe').contentWindow.location.hash = '#/admin/settings'">Khung sang cài đặt</button>
</body></html>`;

const innerPage = `${head('Khung trong')}<body><p>Nội dung khung</p></body></html>`;

/** The answer for `pathname` under `/guard`, or `undefined` (not a guard page). */
export function guardRoute(pathname: string): CrawlAnswer | undefined {
  switch (pathname) {
    case GUARD_PAGES.downloads:
      return { status: 200, type: 'html', body: downloadsPage };
    case GUARD_PAGES.frames:
      return { status: 200, type: 'html', body: framesPage };
    case GUARD_PAGES.frameInScope:
      return { status: 200, type: 'html', body: innerPage };
    case GUARD_PAGES.file:
      return {
        status: 200,
        type: 'csv',
        body: 'ma,ten\n1,An\n',
        filename: 'bao-cao.csv',
      };
    default:
      return undefined;
  }
}
