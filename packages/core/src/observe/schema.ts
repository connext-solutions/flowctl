import { z } from 'zod';
import { ARIA_ROLES } from '../flow/index.js';

/**
 * A same-origin path: starts with one `/`, with no query string or fragment. The map never stores a full URL,
 * so record ids in a query, tokens and other origins stay out of it.
 */
const Path = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)[^?#\s]*$/, 'must be a path: /..., no query or fragment');

/** Text read from the page (names, titles, console lines): untrusted, bounded, never a key or a command. */
const PageText = z.string().max(300);

/** A control as Playwright names it (role and accessible name), the same pair a flow locator uses. */
export const ControlSchema = z
  .object({ role: z.enum(ARIA_ROLES), name: PageText })
  .strict();

/** One field of a form: its control, the input `type` attribute (or `null`) and whether it is required. */
export const FieldSchema = z
  .object({
    role: z.enum(ARIA_ROLES),
    name: PageText,
    type: z.string().max(40).nullable(),
    required: z.boolean(),
  })
  .strict();

/** A form: its accessible name (or `null`), the label of its submit control (or `null`) and its fields. */
export const FormSchema = z
  .object({
    name: PageText.nullable(),
    submit: PageText.nullable(),
    fields: z.array(FieldSchema).max(200),
  })
  .strict();

/** A fetch/xhr call the page made: method, path and status (0 when it got no response). No bodies. */
export const CallSchema = z
  .object({
    method: z.string().regex(/^[A-Z]{3,7}$/),
    path: Path,
    status: z.number().int().min(0).max(599),
  })
  .strict();

/**
 * One page the crawler visited: the document `status` (0 when the navigation got no response), its controls,
 * the same-origin links it offers, its forms, the calls and console errors seen while it was open, and what the
 * run's guards refused while it was open (`refused`: a request out of scope, or a write; the request was aborted).
 */
export const PageSchema = z
  .object({
    path: Path,
    title: PageText,
    status: z.number().int().min(0).max(599),
    controls: z.array(ControlSchema).max(500),
    links: z.array(Path).max(500),
    forms: z.array(FormSchema).max(50),
    calls: z.array(CallSchema).max(500),
    consoleErrors: z.array(PageText).max(100),
    refused: z.array(z.enum(['scope_violation', 'destructive_blocked'])).max(2),
  })
  .strict();

/**
 * What Observe saw of one app, without a model (roadmap section 3.2): the input Derive joins with spec
 * operations, and the evidence an `invariant` or `baseline` assertion can cite (ADR 0020).
 *
 * @remarks Only paths are stored, never full URLs, bodies or field values, so a map is safe to attach to a bug.
 *   `truncated` is true when a page, time or size cap stopped the crawl (T2.5).
 */
export const AppMapSchema = z
  .object({
    v: z.literal(1),
    origin: z
      .string()
      .url()
      .refine((u) => new URL(u).origin === u, 'must be an origin, no path'),
    observedAt: z.string().datetime(),
    truncated: z.boolean(),
    pages: z.array(PageSchema).max(1000),
  })
  .strict();

export type AppMap = z.infer<typeof AppMapSchema>;
export type AppPage = z.infer<typeof PageSchema>;
export type AppForm = z.infer<typeof FormSchema>;
export type AppCall = z.infer<typeof CallSchema>;
