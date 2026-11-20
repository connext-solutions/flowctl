/** Markdown tables for `docs/benchmarks/compare/README.md`, computed from the lines of `results.jsonl`. */

const ARMS = ['llm-devtools', 'llm-kiro-devtools', 'flowctl-explore', 'flowctl-replay'];
/** LLM arms: a run the model API refused (`error`) is excluded, not counted as wrong. */
const LLM = new Set(['llm-devtools', 'llm-kiro-devtools']);
const counted = (arm, r) => !(LLM.has(arm) && r.verdict === 'error');

/** Nearest-rank percentile of `xs` (`p` in 0..100), or `-` for none. */
function pct(xs, p) {
  if (xs.length === 0) return '-';
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}
const sum = (xs) => xs.reduce((n, x) => n + x, 0);
const usd = (x) => `$${x.toFixed(4)}`;
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

/** Precision, speed and cost of one set of runs. */
function stats(runs) {
  const verdicts = runs.filter((r) => r.verdict === 'passed' || r.verdict === 'failed');
  const ok = runs.filter((r) => r.correct === true).length;
  return {
    runs: runs.length,
    correct: ok,
    precision: runs.length === 0 ? '-' : `${((100 * ok) / runs.length).toFixed(1)}%`,
    falsePass: verdicts.filter((r) => r.expected === 'failed' && r.verdict === 'passed').length,
    falseFail: verdicts.filter((r) => r.expected === 'passed' && r.verdict === 'failed').length,
    noVerdict: runs.length - verdicts.length,
    median: pct(
      runs.map((r) => r.wallMs),
      50,
    ),
    p90: pct(
      runs.map((r) => r.wallMs),
      90,
    ),
  };
}

/** Cost cell for an arm: USD and tokens for the LLM arm, `unknown` for System 1, 0 for replay. */
function cost(arm, runs) {
  if (runs.length === 0) return ['-', '-', '-'];
  if (arm === 'llm-devtools') {
    const total = sum(runs.map((r) => r.costUsd ?? 0));
    const tok = (k) => Math.round(sum(runs.map((r) => r[k] ?? 0)) / runs.length);
    return [
      `${usd(total)} total, ${usd(total / runs.length)} per run`,
      `in ${tok('inputTokens')}, out ${tok('outputTokens')}, cache read ${tok('cacheReadTokens')}, cache write ${tok('cacheWriteTokens')}`,
      String(Math.round(sum(runs.map((r) => r.toolCalls ?? 0)) / runs.length)),
    ];
  }
  if (arm === 'llm-kiro-devtools') {
    const total = sum(runs.map((r) => r.credits ?? 0));
    const ctx = (k) => Math.round(sum(runs.map((r) => r.contextTokens?.[k] ?? 0)) / runs.length);
    return [
      `${total.toFixed(3)} credits total, ${(total / runs.length).toFixed(3)} credits per run`,
      `context breakdown ${ctx('total')} (tools ${ctx('tools')}, prompts ${ctx('prompts')}, responses ${ctx('responses')})`,
      String(Math.round(sum(runs.map((r) => r.toolCalls ?? 0)) / runs.length)),
    ];
  }
  if (arm === 'flowctl-explore') {
    const ds = runs.map((r) => r.decisions ?? 0);
    const med = pct(
      runs.map((r) => r.medianDecisionMs).filter((x) => typeof x === 'number'),
      50,
    );
    return [`unknown (${sum(ds)} System 1 decisions, median ${med} ms each)`, 'unknown', '1 (flow_run) + flow_wait'];
  }
  return ['$0 (no model)', '0', '1 (flow_replay)'];
}

/** Every table of the report, as markdown. */
export function report(lines, cases) {
  const out = [];
  const by = (arm) => lines.filter((l) => l.arm === arm && l.retry !== true);
  const errors = lines.filter((l) => l.verdict === 'error');
  out.push('### Overall\n\n');
  out.push(
    table(
      ['Arm', 'Runs', 'Correct', 'Precision', 'False pass', 'False fail', 'No verdict / error / escalated', 'Median wall ms', 'p90 wall ms', 'Cost', 'Tokens (mean per run)', 'Agent tool calls (mean)'],
      ARMS.map((arm) => {
        const runs = by(arm).filter((r) => counted(arm, r));
        const s = stats(runs);
        return [arm, s.runs, s.correct, s.precision, s.falsePass, s.falseFail, s.noVerdict, s.median, s.p90, ...cost(arm, runs)];
      }),
    ),
  );
  out.push('\n\n### Per case\n\n');
  out.push(
    table(
      ['Case', 'Expected', 'Arm', 'Verdicts', 'Correct', 'Median wall ms', 'p90 wall ms', 'Mean cost', 'Mean tool calls'],
      cases.flatMap((c) =>
        ARMS.flatMap((arm) => {
          const runs = by(arm).filter((r) => r.case === c.id && counted(arm, r));
          if (runs.length === 0) return [];
          const s = stats(runs);
          const mean = (k) => (runs.every((r) => typeof r[k] === 'number') ? sum(runs.map((r) => r[k])) / runs.length : null);
          const meanUsd = mean('costUsd');
          const meanTools = mean('toolCalls');
          return [
            [
              c.id,
              c.expected,
              arm,
              runs.map((r) => r.verdict).join(', '),
              `${s.correct}/${s.runs}`,
              s.median,
              s.p90,
              arm === 'flowctl-replay'
                ? '$0'
                : arm === 'llm-kiro-devtools'
                  ? `${(mean('credits') ?? 0).toFixed(3)} credits`
                  : meanUsd === null
                    ? 'unknown'
                    : usd(meanUsd),
              meanTools === null ? '-' : meanTools.toFixed(1),
            ],
          ];
        }),
      ),
    ),
  );
  if (errors.length > 0) {
    out.push('\n\n### Runs that ended in an error (excluded from the LLM arms; counted as not correct for flowctl)\n\n');
    out.push(
      table(
        ['At', 'Arm', 'Case', 'Error', 'Wall ms'],
        errors.map((e) => [e.at, e.arm, e.case, e.error ?? '-', e.wallMs]),
      ),
    );
  }
  const kiro = by('llm-kiro-devtools');
  if (kiro.length > 0) {
    out.push('\n\n### Kiro CLI arm (probe, one run per case)\n\n');
    out.push(
      table(
        ['Case', 'Expected', 'Verdict', 'Credits', 'Wall ms', 'Turn ms (sum)', 'Turns', 'Tool calls', 'Context breakdown tokens', 'Tools / prompts / responses tokens', 'Model'],
        kiro.map((k) => {
          const t = k.contextTokens ?? {};
          return [k.case, k.expected, k.verdict, k.credits?.toFixed(3) ?? '-', k.wallMs, k.durationMs ?? '-', k.numTurns ?? '-', k.toolCalls ?? '-', t.total ?? '-', `${t.tools ?? '-'} / ${t.prompts ?? '-'} / ${t.responses ?? '-'}`, k.model ?? '-'];
        }),
      ),
    );
    const ok = kiro.filter((k) => typeof k.credits === 'number');
    if (ok.length > 0) {
      const avg = sum(ok.map((k) => k.credits)) / ok.length;
      const ctx = Math.round(sum(ok.map((k) => k.contextTokens?.total ?? 0)) / ok.length);
      out.push(`\n\nAverage ${avg.toFixed(3)} credits per run, average context breakdown ${ctx} tokens; 51 runs ≈ ${(51 * avg).toFixed(1)} credits.\n`);
    }
  }
  const explore = by('flowctl-explore');
  if (explore.length > 0) {
    out.push('\n\n### flowctl explore with System 1 (clean app, one run per flow)\n\n');
    out.push(
      table(
        ['Flow', 'Status', 'Escalation', 'Steps', 'System 1 decisions', 'System 1 ms (sum)', 'Median decision ms', 'Wall ms', 'Model', 'Result bytes'],
        explore.map((e) => [e.flow, e.verdict, e.escalation ?? '-', e.steps ?? '-', e.decisions, e.system1Ms, e.medianDecisionMs ?? '-', e.wallMs, e.model, e.resultBytes]),
      ),
    );
  }
  const replay = by('flowctl-replay');
  if (replay.length > 0) {
    const b = replay.map((r) => r.resultBytes);
    out.push(`\n\nflow_replay result size: median ${pct(b, 50)} bytes, max ${Math.max(...b)} bytes.\n`);
  }
  return `${out.join('')}\n`;
}
