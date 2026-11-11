import { readFileSync } from 'node:fs';
import { LEAVE_REQUEST_RULES } from './validator.js';

/** The UI messages, keyed as `contracts/i18n/vi.json` keys them; the pages show exactly these strings. */
export const MESSAGES: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(new URL('../contracts/i18n/vi.json', import.meta.url), 'utf8'),
);

/** The shared rules and messages, as the first lines of a page script. */
const CONTRACT_JS = `const MSG = ${JSON.stringify(MESSAGES)};
const RULES = ${JSON.stringify(LEAVE_REQUEST_RULES)};`;

const head = (title: string): string =>
  `<!doctype html><html lang="vi"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head>`;

const NAV =
  '<nav><a href="/requests">Đơn từ</a> <a href="/approvals">Phê duyệt</a></nav>';

export const LOGIN_PAGE = `${head('Đăng nhập')}<body>
<h1>Đăng nhập</h1>
<a href="/login?as=employee">Nhân viên</a> <a href="/login?as=manager">Quản lý</a>
</body></html>`;

export const HOME_PAGE = `${head('Trang chủ')}<body>${NAV}<h1>Trang chủ</h1></body></html>`;

export const REQUESTS_PAGE = `${head('Đơn từ')}<body>${NAV}
<h1>Đơn từ</h1>
<form id="f" novalidate>
  <label>Lý do <input id="reason" required maxlength="${LEAVE_REQUEST_RULES.reason.maxLength}"></label>
  <label>Số tiền <input id="amount" inputmode="numeric"></label>
  <span id="emp-label">Nhân viên</span>
  <input id="emp" role="combobox" aria-labelledby="emp-label" aria-expanded="false" aria-controls="emp-list" autocomplete="off">
  <ul id="emp-list" role="listbox" aria-label="Danh sách nhân viên"></ul>
  <button type="submit">Gửi</button>
</form>
<p id="err" role="alert"></p>
<div id="toast" role="status"></div>
<table><tbody id="rows"></tbody></table>
<script>
${CONTRACT_JS}
const $ = (s) => document.querySelector(s);
if (window.BUG === 'consoleError') console.error('seeded bug: error on load');

// Money field: formats with thousand separators, and the FIRST edit is wiped by a simulated
// re-mount, the flake that the fill settle and re-check exist for.
let remounted = false;
$('#amount').addEventListener('input', (e) => {
  const el = e.target;
  if (!remounted) { remounted = true; setTimeout(() => { el.value = ''; }, 50); return; }
  const raw = el.value.replace(/\\D/g, '');
  setTimeout(() => { el.value = raw ? Number(raw).toLocaleString('vi-VN') : ''; }, 30);
});

// Employee search listens to keyup only (programmatic fill() does not trigger it), debounced 300 ms.
let timer;
$('#emp').addEventListener('keyup', () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const r = await fetch('/api/employees?q=' + encodeURIComponent($('#emp').value));
    const data = await r.json();
    $('#emp-list').innerHTML = data.items.map((n) => '<li role="option">' + n + '</li>').join('');
    $('#emp').setAttribute('aria-expanded', data.items.length ? 'true' : 'false');
  }, 300);
});
$('#emp-list').addEventListener('click', (e) => {
  if (e.target.getAttribute('role') !== 'option') return;
  $('#emp').value = e.target.textContent;
  $('#emp-list').innerHTML = '';
  $('#emp').setAttribute('aria-expanded', 'false');
});

async function load() {
  const r = await fetch('/api/requests');
  if (!r.ok) { $('#err').textContent = MSG['request.list.failed']; return; }
  const data = await r.json();
  $('#rows').innerHTML = data.items.map((i) =>
    '<tr><td>' + i.reason + '</td><td>' + (window.BUG === 'toastInList' ? MSG['request.submitted'] : i.status === 'APPROVED' ? MSG['request.status.approved'] : MSG['request.status.pending']) + '</td></tr>'
  ).join('');
}

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#err').textContent = '';
  $('#toast').textContent = '';
  const reason = $('#reason').value.trim();
  if (window.BUG !== 'noValidation') {
    if (!reason) { $('#err').textContent = MSG[RULES.reason.requiredKey]; return; }
    if ([...reason].length > RULES.reason.maxLength) { $('#err').textContent = MSG[RULES.reason.maxLengthKey]; return; }
  }
  const body = {
    reason: reason,
    amount: Number($('#amount').value.replace(/\\D/g, '')),
    employee: $('#emp').value,
    type: window.BUG === 'wrongBody' ? 'OT' : 'LEAVE',
  };
  const r = await fetch('/api/requests', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.ok || window.BUG === 'toastOnFail') {
    if (window.BUG !== 'toastInList') $('#toast').textContent = MSG['request.submitted'];
    if (window.BUG !== 'formNotReset') $('#f').reset();
    history.replaceState(null, '', window.BUG === 'redirectWrong' ? '?saved=0' : '?saved=1');
    load();
  }
  else { $('#err').textContent = MSG['request.submit.failed']; }
});
load();
</script></body></html>`;

export const APPROVALS_PAGE = `${head('Phê duyệt')}<body>${NAV}
<h1>Phê duyệt</h1>
<table><tbody id="rows"></tbody></table>
<div id="toast" role="status"></div>
<script>
${CONTRACT_JS}
const $ = (s) => document.querySelector(s);
async function load() {
  const r = await fetch('/api/requests');
  if (!r.ok) return;
  const data = await r.json();
  $('#rows').innerHTML = data.items.filter((i) => i.status === 'PENDING').map((i) =>
    '<tr><td>' + i.reason + '</td><td><button data-id="' + i.id + '" aria-label="Duyệt ' + i.reason + '">Duyệt</button></td></tr>'
  ).join('');
}
document.addEventListener('click', async (e) => {
  const id = e.target.dataset && e.target.dataset.id;
  if (!id) return;
  const r = await fetch('/api/requests/' + id + '/approve', { method: 'PATCH' });
  $('#toast').textContent = r.ok ? MSG['request.approve.done'] : MSG['request.approve.failed'];
  load();
});
load();
</script></body></html>`;

export const LAB_PAGE = `${head('Lab')}<body>${NAV}
<h1>Lab</h1>
<form id="todo"><label>Việc cần làm <input id="todo-input"></label></form>
<ul id="todos"></ul>
<label>Mật khẩu <input type="password" id="pw"></label>
<button data-testid="save-btn">Lưu nháp</button>
<label>Loại đơn <select id="kind"><option>Nghỉ phép</option><option>Tăng ca</option></select></label>
<div class="devtools"><button>Devtools</button></div>
<button aria-label="Open React Query Devtools">RQ</button>
<p id="out" role="status"></p>
<div style="height:900px"></div>
<button id="bottom">Cuối trang</button>
<script>
const $ = (s) => document.querySelector(s);
// One text field and no submit button: only Enter submits (TodoMVC-style), for PRESS_ENTER.
$('#todo').addEventListener('submit', (e) => {
  e.preventDefault();
  const li = document.createElement('li');
  li.textContent = $('#todo-input').value;
  $('#todos').append(li);
  $('#todo-input').value = '';
});
$('[data-testid=save-btn]').addEventListener('click', () => { $('#out').textContent = 'Đã lưu nháp'; });
$('#bottom').addEventListener('click', () => { $('#out').textContent = 'Đã tới cuối'; });
</script></body></html>`;

/** A page with no controls until its script renders one 700 ms after load, like an SPA waiting for its API. */
export const SLOW_PAGE = `${head('Chậm')}<body><div id="app"></div>
<script>setTimeout(() => { document.getElementById('app').innerHTML = '<button>Hiện muộn</button>'; }, 700);</script>
</body></html>`;
