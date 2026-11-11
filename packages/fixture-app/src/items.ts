import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A small items CRUD for the run ledger's browser tests in core (ADR 0024 section 5, "The run ledger"): records with
 * uuid ids, so the digits of a port or a `{{uid}}` never collide with a created id. Like `/guard`, it is a test page
 * apart from the leave pages, holds no seeded bug and is linked from nowhere.
 *
 * - `GET /items` lists the items; each row has a "Xoá" button (`DELETE /api/items/:id`); the form "Tạo" sends
 *   `POST /api/items` `{ name }` and shows the answer.
 * - `POST /api/items` answers 201 with `{ id, name }`, 409 for a name that exists, 400 without a name.
 * - `GET`, `PATCH` (`{ name }`) and `DELETE` on `/api/items/:id` answer 404 for an unknown id; `DELETE` answers 204.
 * - `POST /api/__items/next` `{ id }` sets the id the next create returns (a test seam, like `/api/__reset`).
 */
export const ITEMS_PATH = '/items';

interface Item {
  id: string;
  name: string;
}

const ITEMS_PAGE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Mục</title></head><body>
<h1>Mục</h1>
<form id="f"><label>Tên mục <input name="name" aria-label="Tên mục"></label><button type="submit">Tạo</button></form>
<p role="status" id="msg"></p>
<ul id="list"></ul>
<script>
const msg = document.getElementById('msg');
async function load() {
  const r = await fetch('/api/items');
  const { items } = await r.json();
  const list = document.getElementById('list');
  list.replaceChildren(...items.map((it) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = 'Xoá ' + it.name;
    b.onclick = async () => {
      const d = await fetch('/api/items/' + it.id, { method: 'DELETE' });
      msg.textContent = d.status === 204 ? 'Đã xoá ' + it.name : 'Xoá thất bại';
      await load();
    };
    li.append(it.name + ' ', b);
    return li;
  }));
}
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const name = new FormData(e.target).get('name');
  const r = await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  msg.textContent = r.status === 201 ? 'Đã tạo ' + name : r.status === 409 ? 'Tên đã tồn tại' : 'Tạo thất bại';
  await load();
};
load();
</script></body></html>`;

const send = (res: ServerResponse, status: number, body?: unknown): void => {
  res.writeHead(
    status,
    body === undefined ? {} : { 'content-type': 'application/json' },
  );
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) data += String(chunk);
  const v: unknown = data === '' ? {} : JSON.parse(data);
  return typeof v === 'object' && v !== null
    ? Object.fromEntries(Object.entries(v))
    : {};
}

/** The items store of one fixture and its handlers. */
export function itemsApp(): {
  /** Answers `req` when it is an items page or API call; `false` otherwise. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  reset(): void;
} {
  let items: Item[] = [];
  let next: string | undefined;
  return {
    reset() {
      items = [];
      next = undefined;
    },
    async handle(req, res, url) {
      const p = url.pathname;
      if (req.method === 'GET' && p === ITEMS_PATH) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(ITEMS_PAGE);
        return true;
      }
      if (req.method === 'POST' && p === '/api/__items/next') {
        const b = await bodyOf(req);
        next = typeof b['id'] === 'string' ? b['id'] : undefined;
        send(res, 200, {});
        return true;
      }
      if (p === '/api/items') {
        if (req.method === 'GET') send(res, 200, { items });
        else if (req.method === 'POST') {
          const name = (await bodyOf(req))['name'];
          if (typeof name !== 'string' || name === '')
            send(res, 400, { message: 'name' });
          else if (items.some((i) => i.name === name))
            send(res, 409, { message: 'exists' });
          else {
            const item = { id: next ?? randomUUID(), name };
            next = undefined;
            items.push(item);
            send(res, 201, item);
          }
        } else send(res, 405, { message: 'method' });
        return true;
      }
      const one = /^\/api\/items\/([^/]+)$/.exec(p);
      if (one === null) return false;
      const found = items.find((i) => i.id === one[1]);
      if (found === undefined) send(res, 404, { message: 'not found' });
      else if (req.method === 'GET') send(res, 200, found);
      else if (req.method === 'PATCH') {
        const name = (await bodyOf(req))['name'];
        if (typeof name === 'string') found.name = name;
        send(res, 200, found);
      } else if (req.method === 'DELETE') {
        items = items.filter((i) => i !== found);
        send(res, 204);
      } else send(res, 405, { message: 'method' });
      return true;
    },
  };
}
