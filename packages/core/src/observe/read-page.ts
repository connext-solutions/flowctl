import { z } from 'zod';
import type { PageSnapshot } from '../browser/index.js';
import { ARIA_ROLES } from '../flow/index.js';
import type { RunSession } from '../run/index.js';
import { pageLinks, type LinkRules, type PageLinks } from './links.js';
import { PAGE_SCRIPT } from './page-script.js';
import type { AppForm, AppPage } from './schema.js';

const Text = z.string().max(300);

const ReadSchema = z.object({
  status: z.number().int().min(0).max(599),
  title: Text,
  links: z.array(
    z.object({
      href: z.string(),
      target: z.string(),
      download: z.boolean(),
      name: Text,
    }),
  ),
  forms: z
    .array(
      z.object({
        name: Text.nullable(),
        submit: Text.nullable(),
        fields: z.array(
          z.object({
            role: z.enum(ARIA_ROLES),
            name: Text,
            type: z.string().nullable(),
            required: z.boolean(),
          }),
        ),
      }),
    )
    .max(50),
});

/** At most this many controls and links a page keeps (the `AppMap` caps). */
const MAX_CONTROLS = 500;
const MAX_LINKS = 500;

const ROLES: ReadonlySet<string> = new Set(ARIA_ROLES);
const isRole = (r: string): r is (typeof ARIA_ROLES)[number] => ROLES.has(r);

/** The part of an {@link AppPage} read from the open page; calls, console errors and refusals come from elsewhere. */
export type PageRead = Omit<AppPage, 'calls' | 'consoleErrors' | 'refused'> &
  Pick<PageLinks, 'follow'> & {
    /** A list was cut to its `AppMap` cap. */
    cut: boolean;
  };

/**
 * The snapshot's controls as the map keeps them: role and name only (never a value), roles a locator can use,
 * the first of each identical pair, in page order, at most {@link MAX_CONTROLS}.
 */
function controlsOf(snap: PageSnapshot): AppPage['controls'] {
  const seen = new Set<string>();
  const out: AppPage['controls'] = [];
  for (const c of snap.controls) {
    const key = `${c.role}\u0000${c.name}`;
    if (!isRole(c.role) || seen.has(key)) continue;
    seen.add(key);
    out.push({ role: c.role, name: c.name.slice(0, 300) });
  }
  return out.slice(0, MAX_CONTROLS);
}

/**
 * Reads the open page of `run` at `path`: its document status, title, snapshot controls, forms with their field
 * model and the same-origin links it offers, plus the links the crawl may follow ({@link pageLinks}).
 *
 * @remarks Field values are never read (the page script reads attributes and labels), and the snapshot never lists
 *   password fields, so the map carries no secret a page shows.
 * @throws {RunError} from the run's snapshot (`budget_exceeded` once the deadline closed the page).
 */
export async function readPage(
  run: RunSession,
  path: string,
  rules: LinkRules,
): Promise<PageRead> {
  const raw = ReadSchema.parse(await run.page.evaluate(PAGE_SCRIPT));
  const snap = await run.snapshot();
  const origin = new URL(run.env.baseUrl).origin;
  const { links, follow } = pageLinks(raw.links, origin, rules);
  const forms: AppForm[] = raw.forms.map((f) => ({
    name: f.name,
    submit: f.submit,
    fields: f.fields.map((x) => ({ ...x, type: x.type?.slice(0, 40) ?? null })),
  }));
  return {
    path,
    title: raw.title,
    status: raw.status,
    controls: controlsOf(snap),
    links: links.slice(0, MAX_LINKS),
    forms,
    follow,
    cut: links.length > MAX_LINKS,
  };
}
