import { NAME_PATTERN } from '../config.js';
import { TRUST_SUBCOMMANDS } from '../foundation/index.js';
import type { Page } from 'playwright';
import { z } from 'zod';
import { SourceRefSchema } from './source-ref.js';

type AriaRole = Parameters<Page['getByRole']>[0];

export const ARIA_ROLES = [
  'alert',
  'alertdialog',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'dialog',
  'form',
  'grid',
  'gridcell',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'main',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'option',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowheader',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'textbox',
  'toolbar',
  'tooltip',
  'tree',
  'treeitem',
] as const satisfies readonly AriaRole[];

export const LocSchema = z
  .object({
    testId: z.string().optional(),
    role: z.enum(ARIA_ROLES).optional(),
    name: z.string().optional(),
  })
  .strict()
  .refine((l) => l.testId !== undefined || l.role !== undefined, {
    message: 'locator needs testId or role',
  });
export type Loc = z.infer<typeof LocSchema>;

const NetworkSchema = z
  .object({
    method: z.string(),
    url: z.string(),
    status: z.number().int().optional(),
    requestBody: z.unknown().optional(),
    absent: z.boolean().optional(),
  })
  .strict();

const assertionUnion = <E extends z.ZodRawShape>(extra: E) =>
  z.union([
    z.object({ network: NetworkSchema, ...extra }).strict(),
    z
      .object({ text: z.string(), within: LocSchema.optional(), ...extra })
      .strict(),
    z.object({ url: z.string(), ...extra }).strict(),
    z
      .object({
        value: z.object({ locator: LocSchema, equals: z.string() }).strict(),
        ...extra,
      })
      .strict(),
    z.object({ noConsoleErrors: z.literal(true), ...extra }).strict(),
  ]);

/**
 * One expected item. Any assertion may carry a `sourceRef` (ADR 0020 section a); only a flow marked `derived` may.
 */
export const AssertionSchema = assertionUnion({
  sourceRef: SourceRefSchema.optional(),
});

/**
 * An assertion as an exploration request may state it: the same shapes without `sourceRef`, so an agent cannot
 * declare provenance for what it asks to check (ADR 0020 section b).
 */
export const RequestAssertionSchema = assertionUnion({});
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * A copy of `assertion` without its `sourceRef`: what a run expands, checks and reports.
 *
 * @remarks Spec text in a quote can hold `{{`, and an assertion that fails is returned to the orchestrator, a
 *   model: dropping the reference before templates are expanded and before the verifier runs keeps the quote out of
 *   both (ADR 0020 section h: an unverified flow never shows a quote as fact).
 */
export const withoutSourceRef = (assertion: Assertion): Assertion => {
  const { sourceRef: _dropped, ...rest } = assertion;
  return rest;
};

const InputSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ env: z.string() }).strict(),
]);

export const FlowSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, 'use lowercase letters, digits and dashes')
      .refine((n) => !TRUST_SUBCOMMANDS.includes(n), {
        message: 'is a flowctl trust subcommand; rename the flow',
      }),
    goal: z.string(),
    tags: z.array(z.string()).default([]),
    profile: z.string(),
    setup: z.string().optional(),
    teardown: z.string().optional(),
    start: z.string().refine((s) => s.startsWith('/') || s.startsWith('{{'), {
      message: 'start must be a path starting with / (or with a template)',
    }),
    inputs: z.record(z.string(), InputSchema).default({}),
    steps: z.array(z.record(z.string(), z.unknown())).min(1),
    assertions: z.array(AssertionSchema).min(1),
    derived: z.literal(true).optional(),
    recorded: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (f) =>
      f.derived === true ||
      f.assertions.every((a) => a.sourceRef === undefined),
    {
      path: ['derived'],
      message:
        'an assertion carries a sourceRef, so the flow needs "derived: true"; a hand-written flow carries none',
    },
  );
export type FlowDoc = z.infer<typeof FlowSchema>;

export type By = 'system1' | 'system2';
// dup-ok: flowctl is a standalone package; unrelated to the Storybook `Step` in ui-components.
export type Step = (
  | { kind: 'click' | 'check' | 'hover'; target: Loc }
  | { kind: 'fill' | 'select'; target: Loc; input: string }
  | { kind: 'press'; key: string }
  | { kind: 'goto'; url: string }
  | { kind: 'reload' }
  | { kind: 'wait'; ms: number }
  | { kind: 'scroll'; dy: number }
  | { kind: 'upload'; target: Loc; file: string }
  | { kind: 'drag'; target: Loc; to: Loc }
  | { kind: 'as'; profile: string; goto?: string }
) & { by?: By };

export interface Flow extends FlowDoc {
  file: string;
  parsedSteps: Step[];
}

export { FlowError } from '../foundation/index.js';

/** Human-readable text for zod and ordinary errors. */
export const errorText = (e: unknown): string =>
  e instanceof z.ZodError
    ? z.prettifyError(e)
    : e instanceof Error
      ? e.message
      : String(e);
