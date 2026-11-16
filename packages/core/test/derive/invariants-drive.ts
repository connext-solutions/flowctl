import { randomBytes } from 'node:crypto';
import type { Browser, Page, Response } from 'playwright';
import {
  DriveRecordSchema,
  type DriveRecord,
  type DriveStep,
} from '../../src/derive/index.js';

const NAME = { role: 'textbox', name: 'Tên mục' } as const;
const RENAME = { role: 'textbox', name: 'Tên mới' } as const;
const CREATE = { role: 'button', name: 'Tạo' } as const;
const EDIT = { role: 'button', name: 'Sửa' } as const;
const APPROVE = { role: 'button', name: 'Duyệt' } as const;
const DELETE = { role: 'button', name: 'Xoá' } as const;

type Call = NonNullable<DriveStep['request']>;

/**
 * A stand-in for the drive stage (T2.8) in the tests of the invariant library: it drives the `/items` app of
 * fixture-app through a browser and writes the record T2.8 must emit (ADR 0041 section 3). It reads only values it
 * wrote itself, all `QA-` prefixed.
 */
export interface ItemsDrive {
  record: DriveRecord;
  /** The `{ value }` inputs the drive wrote through, by name, as the flow would hold them. */
  inputs: Record<string, string>;
}

/**
 * Runs `click` and returns the first answered request to `path` with `method`. It waits until the status line changed
 * (every action of the app writes one) and the page has no request in flight for 150 ms, so the list is redrawn.
 */
async function act(
  page: Page,
  method: string,
  path: RegExp,
  click: () => Promise<void>,
): Promise<Call | null> {
  const found: Call[] = [];
  let inflight = 0;
  const onResponse = (r: Response): void => {
    const url = new URL(r.url());
    if (r.request().method() === method && path.test(url.pathname))
      found.push({ method, path: url.pathname, status: r.status() });
  };
  const start = (): void => void (inflight += 1);
  const end = (): void => void (inflight = Math.max(0, inflight - 1));
  const status = page.locator('#msg');
  const previous = await status.innerText();
  page.on('response', onResponse);
  page.on('request', start);
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  try {
    await click();
    await page
      .waitForFunction(
        (p) => document.getElementById('msg')?.textContent !== p,
        previous,
        { timeout: 3000 },
      )
      .catch(() => undefined);
    for (let quiet = 0, ticks = 0; quiet < 3 && ticks < 100; ticks += 1) {
      await page.waitForTimeout(50);
      quiet = inflight === 0 ? quiet + 1 : 0;
    }
  } finally {
    page.off('response', onResponse);
    page.off('request', start);
    page.off('requestfinished', end);
    page.off('requestfailed', end);
  }
  return found[0] ?? null;
}

const row = (page: Page, value: string) =>
  page.locator('li').filter({ hasText: value }).first();

/** What the page shows of `value` now: whether it is in the list (not the status line) and the state of its row. */
async function seen(page: Page, value: string) {
  const text = await page.locator('#list').innerText();
  const state = row(page, value).locator('.state');
  return {
    listed: text.includes(value),
    state: (await state.count()) === 0 ? null : await state.innerText(),
  };
}

const toast = async (page: Page): Promise<string | null> =>
  (await page.locator('#msg').innerText()) || null;

/** Reloads the page, then asks it to list again, as a user who reloads and waits would see. */
async function reload(page: Page, value: string) {
  await page.reload();
  await page.waitForLoadState('networkidle');
  const reloaded = await seen(page, value);
  const name = row(page, value).locator('.name');
  const readBack = reloaded.listed ? await name.innerText() : null;
  await page.evaluate('load()');
  await page.waitForLoadState('networkidle');
  return { reloaded, readBack };
}

/** Drives create, edit, transition, delete, a duplicate create and an over-long probe on `/items`. */
export async function driveItems(
  browser: Browser,
  baseUrl: string,
): Promise<ItemsDrive> {
  const uid = randomBytes(4).toString('hex');
  const created = `QA-${uid}`;
  const renamed = `QA-${uid}-e`;
  const other = `QA-2${uid}`;
  const context = await browser.newContext({ baseURL: baseUrl });
  await context.addCookies([{ name: 'role', value: 'employee', url: baseUrl }]);
  const page = await context.newPage();
  const steps: DriveStep[] = [];
  const base = { page: '/items', clientBlocked: false } as const;
  try {
    await page.goto('/items');
    await page.waitForLoadState('networkidle');

    const create = async (value: string, withReload: boolean) => {
      const before = await seen(page, value);
      await page.getByRole(NAME.role, { name: NAME.name }).fill(value);
      const request = await act(page, 'POST', /^\/api\/items$/, () =>
        page.getByRole(CREATE.role, { name: CREATE.name }).click(),
      );
      const after = await seen(page, value);
      const message = await toast(page);
      const back = withReload ? await reload(page, value) : null;
      steps.push({
        ...base,
        action: 'create',
        control: CREATE,
        field: NAME,
        sent: value,
        request,
        before,
        after,
        reloaded: back?.reloaded ?? null,
        readBack: back?.readBack ?? null,
        toast: message,
      });
    };
    await create(created, true);

    const beforeEdit = await seen(page, created);
    await row(page, created)
      .getByRole(RENAME.role, { name: RENAME.name })
      .fill(renamed);
    const edit = await act(page, 'PATCH', /^\/api\/items\/[^/]+$/, () =>
      row(page, created).getByRole(EDIT.role, { name: EDIT.name }).click(),
    );
    const afterEdit = await seen(page, renamed);
    const editToast = await toast(page);
    const editBack = await reload(page, renamed);
    steps.push({
      ...base,
      action: 'edit',
      control: EDIT,
      field: RENAME,
      sent: renamed,
      request: edit,
      before: { listed: beforeEdit.listed, state: null },
      after: afterEdit,
      reloaded: editBack.reloaded,
      readBack: editBack.readBack,
      toast: editToast,
    });
    const current = afterEdit.listed ? renamed : created;

    await page.evaluate(
      `fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(other)} }) })`,
    );
    await page.evaluate('load()');
    await page.waitForLoadState('networkidle');
    const beforeState = await seen(page, other);
    const approve = await act(page, 'POST', /\/approve$/, () =>
      row(page, other).getByRole(APPROVE.role, { name: APPROVE.name }).click(),
    );
    steps.push({
      ...base,
      action: 'transition',
      control: APPROVE,
      sent: other,
      request: approve,
      before: beforeState,
      after: await seen(page, other),
      reloaded: null,
      readBack: null,
      toast: await toast(page),
    });

    await page.getByRole(NAME.role, { name: NAME.name }).fill(other);
    const duplicate = await act(page, 'POST', /^\/api\/items$/, () =>
      page.getByRole(CREATE.role, { name: CREATE.name }).click(),
    );
    steps.push({
      ...base,
      action: 'create',
      control: CREATE,
      field: NAME,
      sent: other,
      request: duplicate,
      before: await seen(page, other),
      after: await seen(page, other),
      reloaded: null,
      readBack: null,
      toast: await toast(page),
    });

    const beforeDelete = await seen(page, current);
    const del = await act(page, 'DELETE', /^\/api\/items\/[^/]+$/, () =>
      page
        .getByRole(DELETE.role, {
          name: `${DELETE.name} ${current}`,
          exact: true,
        })
        .click(),
    );
    steps.push({
      ...base,
      action: 'delete',
      control: DELETE,
      sent: current,
      request: del,
      before: beforeDelete,
      after: await seen(page, current),
      reloaded: null,
      readBack: null,
      toast: await toast(page),
    });

    const long = `QA-${'x'.repeat(38)}`;
    await page.getByRole(NAME.role, { name: NAME.name }).fill(long);
    const sent = await act(page, 'POST', /^\/api\/items$/, () =>
      page.getByRole(CREATE.role, { name: CREATE.name }).click(),
    );
    steps.push({
      ...base,
      action: 'probe',
      control: CREATE,
      field: NAME,
      sent: long,
      request: sent,
      clientBlocked: sent === null,
      before: { listed: false, state: null },
      after: await seen(page, long),
      reloaded: null,
      readBack: null,
      toast: await toast(page),
    });
  } finally {
    await context.close();
  }
  return {
    record: DriveRecordSchema.parse({ v: 1, steps }),
    inputs: { name: 'QA-{{uid}}', rename: 'QA-{{uid}}-e' },
  };
}
