import { z } from 'zod';
import { NAME_PATTERN } from '../foundation/index.js';

/**
 * A field of a login recipe: one of its label or its test id, never a selector or a value (ADR 0024 section 1,
 * `target.profiles.<n>.login`: selectors and recipe only; origins and secrets come from the store).
 */
const LoginField = z
  .object({ label: z.string().min(1) })
  .strict()
  .or(z.object({ testId: z.string().min(1) }).strict());

/** How a profile logs in: the login page's path on the env origin and the three controls (used by T1.4). */
const LoginRecipe = z
  .object({
    path: z.string().default('/login'),
    username: LoginField,
    password: LoginField,
    submit: LoginField,
  })
  .strict();

const Budgets = z
  .object({
    pages: z.number().int().positive().optional(),
    wallClockMs: z.number().int().positive().optional(),
    costUsd: z.number().positive().optional(),
  })
  .strict();

/**
 * The `target:` section of `flowctl.config.yaml` (ADR 0024 section 1): what one project's runs may reach and spend.
 * Every key only narrows; the effective configuration drops or caps a value that would widen what the store and the
 * built-in ceilings allow, with a warning. `scope.visit` and `scope.call` left out mean the whole ceiling; a list,
 * even an empty one, is intersected with it.
 */
export const TargetSchema = z
  .object({
    scope: z
      .object({
        visit: z.array(z.string()).optional(),
        call: z.array(z.string()).optional(),
        allow: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
      })
      .strict()
      .default({ allow: [], deny: [] }),
    budgets: Budgets.default({}),
    destructiveWords: z.array(z.string()).default([]),
    profiles: z
      .record(
        z
          .string()
          .regex(NAME_PATTERN, 'use lowercase letters, digits and dashes'),
        z.object({ login: LoginRecipe.optional() }).strict(),
      )
      .default({}),
  })
  .strict();

export type Target = z.infer<typeof TargetSchema>;
