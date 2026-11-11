import { confirmLine, type DestructivePlan, displayText } from '@flowctl/core';
import type { Tty } from './trust-tty.js';

/** How many lines the built-in pager shows before it waits for Enter (ADR 0025 section 3: no `$PAGER`). */
const PAGE_LINES = 40;

/** Writes `lines` to the terminal, {@link PAGE_LINES} at a time, waiting for Enter between pages. */
export function paged(tty: Tty, lines: readonly string[]): void {
  for (let i = 0; i < lines.length; i += PAGE_LINES) {
    tty.write(`${lines.slice(i, i + PAGE_LINES).join('\n')}\n`);
    if (i + PAGE_LINES < lines.length) tty.ask('-- Enter for more --');
  }
}

/** The full owner screen of a confirmation, before any question (ADR 0024 section 5, ADR 0025 section 3). */
export function screen(p: DestructivePlan): string[] {
  const host = new URL(p.env.origin).host;
  const lines = [
    `\n=== destructive confirmation for flow ${p.flow.name} ===`,
    `env ${p.env.name}: ${displayText(p.env.origin)}${/[^\x20-\x7e]/.test(p.env.origin) ? ` (${host})` : ''}, class ${p.env.class}`,
    `confirmation digest: ${p.plan.digest}`,
  ];
  for (const f of p.files)
    lines.push(
      `--- file ${f.path} (${f.bytes} bytes, sha256 ${f.sha256}) ---`,
      ...displayText(f.text ?? '')
        .replace(/\n$/, '')
        .split('\n'),
      `--- end of ${f.path} ---`,
    );
  const vars = Object.entries(p.input.vars);
  lines.push(
    `vars: ${vars.length === 0 ? '(none)' : vars.map(([k, v]) => `${k}=${displayText(v)}`).join(', ')}`,
  );
  lines.push(
    'previous version: no previous version (a stored entry keeps only the digest, not the hash of each file, so no diff base can be found)',
  );
  for (const e of p.previous)
    lines.push(`  replaces: ${displayText(confirmLine(e))}`);
  lines.push(
    `recorded run ${p.run.id} on env ${p.run.env} (${displayText(p.run.origin)}), its writes:`,
  );
  for (const w of p.writes)
    lines.push(
      `  ${w.method} ${w.template} ${w.contentType ?? '-'} bodyKeys [${w.bodyKeys.join(',')}] queryKeys [${w.queryKeys.join(',')}] answered ${w.statuses.join(',')}`,
    );
  for (const s of p.skipped)
    lines.push(`  not offered: ${displayText(s.request)}: ${s.why}`);
  return lines.map(displayText);
}
