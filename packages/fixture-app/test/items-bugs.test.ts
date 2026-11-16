import { describe, expect, it } from 'vitest';
import {
  INVARIANT_BUG_MODES,
  startFixture,
  type InvariantBugMode,
} from '../src/index.js';

const AUTH = { cookie: 'role=employee' };
const JSON_H = { ...AUTH, 'content-type': 'application/json' };

interface Listed {
  items: { id: string; name: string }[];
  approved: string[];
}

/** Runs `body` against a fixture started with `bug`, and closes it. */
async function withItems(
  bug: InvariantBugMode | undefined,
  body: (url: string) => Promise<void>,
): Promise<void> {
  const f = await startFixture(bug);
  try {
    await body(f.url);
  } finally {
    await f.close();
  }
}

const post = (url: string, name: string): Promise<Response> =>
  fetch(`${url}/api/items`, {
    method: 'POST',
    headers: JSON_H,
    body: JSON.stringify({ name }),
  });

const list = async (url: string, initial = false): Promise<Listed> =>
  (await (
    await fetch(`${url}/api/items${initial ? '?initial=1' : ''}`, {
      headers: AUTH,
    })
  ).json()) as Listed;

describe('items app, clean', () => {
  it('lists, edits, approves and deletes', async () => {
    await withItems(undefined, async (url) => {
      const created = (await (await post(url, 'a')).json()) as { id: string };
      const patched = await fetch(`${url}/api/items/${created.id}`, {
        method: 'PATCH',
        headers: JSON_H,
        body: JSON.stringify({ name: 'b' }),
      });
      expect(patched.status).toBe(200);
      expect((await list(url, true)).items.map((i) => i.name)).toEqual(['b']);
      const approved = await fetch(`${url}/api/items/${created.id}/approve`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(approved.status).toBe(200);
      expect((await list(url)).approved).toEqual([created.id]);
      const gone = await fetch(`${url}/api/items/${created.id}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      expect(gone.status).toBe(204);
      expect((await list(url)).items).toEqual([]);
    });
  });

  it('rejects a name longer than 40 characters with 400', async () => {
    await withItems(undefined, async (url) => {
      expect((await post(url, 'x'.repeat(41))).status).toBe(400);
      expect((await post(url, 'x'.repeat(40))).status).toBe(201);
    });
  });

  it('serves a page that carries no bug mode', async () => {
    await withItems(undefined, async (url) => {
      const html = await (
        await fetch(`${url}/items`, { headers: AUTH })
      ).text();
      expect(html).toContain('window.ITEMS_BUG=""');
    });
  });
});

describe('items app, seeded invariant bugs', () => {
  it('names the eight modes', () => {
    expect([...INVARIANT_BUG_MODES]).toEqual([
      'createNotListed',
      'editNotShown',
      'deleteStillListed',
      'reloadLosesData',
      'readBackAltered',
      'itemApproveNoop',
      'toastOnConflict',
      'clientLimitMissing',
    ]);
  });

  it('editNotShown: PATCH answers 200 and the name stays', async () => {
    await withItems('editNotShown', async (url) => {
      const c = (await (await post(url, 'a')).json()) as { id: string };
      const r = await fetch(`${url}/api/items/${c.id}`, {
        method: 'PATCH',
        headers: JSON_H,
        body: JSON.stringify({ name: 'b' }),
      });
      expect(r.status).toBe(200);
      expect((await list(url)).items.map((i) => i.name)).toEqual(['a']);
    });
  });

  it('deleteStillListed: DELETE answers 204 and the item stays', async () => {
    await withItems('deleteStillListed', async (url) => {
      const c = (await (await post(url, 'a')).json()) as { id: string };
      const r = await fetch(`${url}/api/items/${c.id}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      expect(r.status).toBe(204);
      expect((await list(url)).items).toHaveLength(1);
    });
  });

  it('reloadLosesData: the page-load list drops the item, a later list keeps it', async () => {
    await withItems('reloadLosesData', async (url) => {
      await post(url, 'a');
      expect((await list(url)).items).toHaveLength(1);
      expect((await list(url, true)).items).toHaveLength(0);
    });
  });

  it('readBackAltered: the page-load list returns the name with a dot', async () => {
    await withItems('readBackAltered', async (url) => {
      await post(url, 'a');
      expect((await list(url)).items.map((i) => i.name)).toEqual(['a']);
      expect((await list(url, true)).items.map((i) => i.name)).toEqual(['a.']);
    });
  });

  it('itemApproveNoop: approve answers 200 and nothing is approved', async () => {
    await withItems('itemApproveNoop', async (url) => {
      const c = (await (await post(url, 'a')).json()) as { id: string };
      const r = await fetch(`${url}/api/items/${c.id}/approve`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(r.status).toBe(200);
      expect((await list(url)).approved).toEqual([]);
    });
  });

  it('serves the mode to the page for the client-side modes', async () => {
    for (const bug of [
      'createNotListed',
      'toastOnConflict',
      'clientLimitMissing',
    ] as const)
      await withItems(bug, async (url) => {
        const html = await (
          await fetch(`${url}/items`, { headers: AUTH })
        ).text();
        expect(html).toContain(`window.ITEMS_BUG="${bug}"`);
      });
  });

  it('leaves no mode on after a reset', async () => {
    await withItems('reloadLosesData', async (url) => {
      await post(url, 'a');
      await fetch(`${url}/api/__reset`, { method: 'POST', headers: AUTH });
      expect((await list(url, true)).items).toEqual([]);
    });
  });
});
