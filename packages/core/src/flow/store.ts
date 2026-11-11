import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { z } from 'zod';
import {
  FlowError,
  FlowSchema,
  errorText,
  type Flow,
  type Loc,
  type Step,
} from './schema.js';
import { writeFileNoFollow } from '../safe-fs.js';
import { normalizeSteps, normalizeStepsWithSources } from './steps.js';
import { checkTemplates } from './templates.js';

/**
 * Reads and validates one flow file.
 *
 * @throws {FlowError} on invalid YAML/schema, a `name` that differs from the file name, an unknown
 *   profile, an invalid step, a step using an undeclared input, or a malformed `{{...}}` template
 *   in `start`, input values, steps or assertions (the message names the field and the character
 *   offset). `setup` and `teardown` are shell text and are never checked or expanded.
 */
export function loadFlow(file: string, profiles: string[]): Flow {
  const parsed = FlowSchema.safeParse(parse(readFileSync(file, 'utf8')));
  if (!parsed.success)
    throw new FlowError(`${file}:\n${z.prettifyError(parsed.error)}`);
  const doc = parsed.data;
  if (basename(file, '.yaml') !== doc.name) {
    throw new FlowError(`${file}: name "${doc.name}" must match the file name`);
  }
  if (!profiles.includes(doc.profile))
    throw new FlowError(`${file}: unknown profile "${doc.profile}"`);
  let parsedSteps: Step[];
  try {
    parsedSteps = normalizeSteps(doc.steps, profiles);
  } catch (e) {
    throw new FlowError(`${file}: ${errorText(e)}`);
  }
  for (const s of parsedSteps) {
    if (
      (s.kind === 'fill' || s.kind === 'select') &&
      !(s.input in doc.inputs)
    ) {
      throw new FlowError(`${file}: step uses unknown input "${s.input}"`);
    }
  }
  try {
    checkTemplates(
      {
        start: doc.start,
        inputs: Object.fromEntries(
          Object.entries(doc.inputs).flatMap(([k, v]) =>
            'value' in v ? [[k, v.value]] : [],
          ),
        ),
        steps: parsedSteps,
        assertions: doc.assertions,
      },
      '',
    );
  } catch (e) {
    throw new FlowError(`${file}: ${errorText(e)}`);
  }
  return { ...doc, file, parsedSteps };
}

/** One flow file that could not be loaded. */
export interface FlowFileError {
  file: string;
  message: string;
}

interface Scan {
  flows: Flow[];
  failures: { file: string; error: unknown }[];
}

function scanFlows(flowsPath: string, profiles: string[]): Scan {
  const scan: Scan = { flows: [], failures: [] };
  if (!existsSync(flowsPath)) return scan;
  for (const f of readdirSync(flowsPath)
    .filter((n) => n.endsWith('.yaml'))
    .sort()) {
    const file = join(flowsPath, f);
    try {
      scan.flows.push(loadFlow(file, profiles));
    } catch (error) {
      scan.failures.push({ file, error });
    }
  }
  return scan;
}

function select(
  flows: Flow[],
  knownNames: string[],
  sel: { names?: string[]; tag?: string },
): Flow[] {
  const names = sel.names ?? [];
  const missing = names.filter(
    (n) => !flows.some((f) => f.name === n) && !knownNames.includes(n),
  );
  if (missing.length > 0)
    throw new FlowError(`Flow not found: ${missing.join(', ')}`);
  return flows.filter(
    (f) =>
      (names.length === 0 || names.includes(f.name)) &&
      (sel.tag === undefined || f.tags.includes(sel.tag)),
  );
}

/**
 * Loads every `*.yaml` in `flowsPath` (sorted) and filters by names and/or tag.
 *
 * @returns `[]` when `flowsPath` does not exist.
 * @throws {FlowError} when a requested name has no flow, or any flow file is invalid (the first
 *   invalid file in name order; other files are not reported, use {@link findFlowsWithErrors}).
 */
export function findFlows(
  flowsPath: string,
  profiles: string[],
  sel: { names?: string[]; tag?: string },
): Flow[] {
  const { flows, failures } = scanFlows(flowsPath, profiles);
  const first = failures[0];
  if (first !== undefined) throw first.error;
  return select(flows, [], sel);
}

/**
 * Like {@link findFlows}, but an invalid file does not stop the others.
 *
 * @returns `flows` selected by `sel`, and `errors` for every invalid file in the folder, in name
 *   order. Every message names the file: when the underlying error (a YAML syntax error, an
 *   `EISDIR` from a directory called `x.yaml`) does not, it is prefixed with the file name. Invalid files are always listed, whatever `sel` says: they cannot be tested against a
 *   tag, and a run must not look green while a file is broken.
 * @throws {FlowError} when a requested name matches neither a valid flow nor an invalid file name.
 * @see docs/adr/0026-template-syntax.md
 */
export function findFlowsWithErrors(
  flowsPath: string,
  profiles: string[],
  sel: { names?: string[]; tag?: string },
): { flows: Flow[]; errors: FlowFileError[] } {
  const { flows, failures } = scanFlows(flowsPath, profiles);
  const errors = failures.map((x) => {
    const text = errorText(x.error);
    const name = basename(x.file);
    return {
      file: x.file,
      message: text.includes(name) ? text : `${name}: ${text}`,
    };
  });
  const invalidNames = failures.map((x) => basename(x.file, '.yaml'));
  return { flows: select(flows, invalidNames, sel), errors };
}

const TARGET_KINDS = ['click', 'check', 'hover', 'fill', 'select'] as const;
const RawStepsSchema = z.object({
  steps: z.array(z.record(z.string(), z.unknown())),
});

/**
 * Replaces the locators of some steps in a flow file, keeping everything else (comments, order,
 * quoting) as written.
 *
 * @param changes index in `Flow.parsedSteps` → new locator; only click/check/hover/fill/select
 *   steps change.
 * @remarks Indices are mapped back to the YAML list through {@link normalizeStepsWithSources}, so a
 *   profile switch written as one entry or as `as` + `goto` entries maps the same way.
 * @throws {FlowError} when the file no longer parses as flow steps (it was loaded before, so only
 *   if it changed on disk in between).
 */
export function updateLocators(file: string, changes: Map<number, Loc>): void {
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const { steps } = RawStepsSchema.parse(doc.toJS());
  const { sources } = normalizeStepsWithSources(steps);
  for (const [index, loc] of changes) {
    const i = sources[index];
    const s = i === undefined ? undefined : steps[i];
    const kind = s === undefined ? undefined : TARGET_KINDS.find((k) => k in s);
    if (kind !== undefined) doc.setIn(['steps', i, kind], doc.createNode(loc));
  }
  writeFileNoFollow(file, doc.toString());
}
