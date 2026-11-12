import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A page that echoes what is typed into it everywhere a run can see it, for core's redaction tests (T1.5). Like
 * `/items`, it is a test page apart from the leave pages, holds no seeded bug and is linked from nowhere.
 *
 * - `GET /echo` shows a password field "Mật khẩu", a text field "Ghi chú", a second password field "Mã cũ" that
 *   already holds {@link ECHO_PREFILL} (as a browser's autofill would; nothing sends it), and a button "Kiểm tra".
 * - "Kiểm tra" moves the address bar to `/echo?q=<Mật khẩu>`, sends `POST /api/echo?q=<Mật khẩu>` with the JSON
 *   body `{ "ghiChu": <Ghi chú>, "matKhau": <Mật khẩu> }`, and shows "Đã nhận: " and the answer's `daNhan` as text in
 *   the status region.
 * - `POST /api/echo` answers 422 with `{ "daNhan": <matKhau>, "ghiChu": <ghiChu>, "q": <q> }`, every non-ASCII
 *   character written as a `\u` escape, as a server that escapes non-ASCII output does. A refusal that quotes the
 *   input back is the answer whose body a run keeps (only answers of 400 and above are read). A body that is not
 *   JSON answers 400.
 *
 * No field name is a credential name, so only matching the typed value itself can mask it.
 */
export const ECHO_PATH = '/echo';

/** The value "Mã cũ" holds when the page loads: a password no run types, so only hiding password fields hides it. */
export const ECHO_PREFILL = 'Tu-dien-9x7Q-cu';

const ECHO_PAGE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Kiểm tra</title></head><body>
<h1>Kiểm tra</h1>
<form id="f">
<label>Mật khẩu <input type="password" id="pw"></label>
<label>Ghi chú <input id="note"></label>
<label>Mã cũ <input type="password" id="old" value="${ECHO_PREFILL}"></label>
<button type="submit">Kiểm tra</button>
</form>
<p role="status" id="echo"></p>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const pw = document.getElementById('pw').value;
  const q = encodeURIComponent(pw);
  history.replaceState(null, '', '/echo?q=' + q);
  const r = await fetch('/api/echo?q=' + q, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ghiChu: document.getElementById('note').value, matKhau: pw }),
  });
  document.getElementById('echo').textContent = 'Đã nhận: ' + (await r.json()).daNhan;
};
</script>
</body></html>`;

const asciiJson = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** Answers `/echo` and `/api/echo`; `false` for any other path. The caller has checked the session. */
export async function echoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === ECHO_PATH) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ECHO_PAGE);
    return true;
  }
  if (req.method !== 'POST' || url.pathname !== '/api/echo') return false;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const data = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = data === '' ? {} : JSON.parse(data);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"message":"not JSON"}');
    return true;
  }
  const body = new Map(
    typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : [],
  );
  res.writeHead(422, { 'content-type': 'application/json' });
  res.end(
    asciiJson({
      daNhan: body.get('matKhau'),
      ghiChu: body.get('ghiChu'),
      q: url.searchParams.get('q'),
    }),
  );
  return true;
}
