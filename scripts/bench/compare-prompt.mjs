/**
 * Turns a fixture flow (its YAML) into the words the LLM arm of the comparison gets: the same start page, the
 * same steps and every assertion stated as an expectation. Nothing here reads the app; the prompt says only what
 * the flow file says.
 */

/** `{{uid}}` in a flow value, replaced by the run's unique tag. */
const fill = (value, uid) => String(value).replaceAll('{{uid}}', uid);

/** `{ role: textbox, name: "Lý do" }` as words. */
const target = (loc) => `the ${loc.role} named "${loc.name}"`;

/** The flow's steps as numbered sentences. */
function stepLines(flow, base, uid) {
  const inputs = Object.fromEntries(
    Object.entries(flow.inputs ?? {}).map(([k, v]) => [k, fill(v.value, uid)]),
  );
  return (flow.steps ?? []).map((s) => {
    if (s.fill !== undefined) return `Type "${inputs[s.input]}" into ${target(s.fill)}.`;
    if (s.click !== undefined) return `Click ${target({ ...s.click, name: fill(s.click.name, uid) })}.`;
    if (s.as !== undefined)
      return `Switch to the ${s.as} role: open ${base}/login?as=${s.as}, then open ${base}${s.goto}.`;
    if (s.goto !== undefined) return `Open ${base}${s.goto}.`;
    if (s.reload === true) return 'Reload the page.';
    if (s.wait !== undefined) return `Wait ${s.wait} ms.`;
    throw new Error(`step kind not rendered: ${JSON.stringify(s)}`);
  });
}

/** One assertion as an expectation the agent must check. */
function expectation(a, uid) {
  if (a.network !== undefined) {
    const n = a.network;
    if (n.absent === true) return `No ${n.method} request to ${n.url} was sent at any point during the flow.`;
    const body =
      n.requestBody === undefined
        ? ''
        : `, and its JSON request body contains ${JSON.stringify(n.requestBody)} (these fields with exactly these values)`;
    const glob = n.url.includes('*') ? ' (`*` matches one path segment)' : '';
    return `A ${n.method} request to ${n.url}${glob} was sent during the flow and answered with HTTP status ${n.status}${body}.`;
  }
  if (a.text !== undefined) {
    const where =
      a.within === undefined
        ? 'on the final page'
        : `inside the element with ARIA role "${a.within.role}" on the final page (the text elsewhere on the page does not count)`;
    return `The text "${fill(a.text, uid)}" is visible ${where} (exact, case-sensitive).`;
  }
  if (a.url !== undefined) return `The final page URL, without the origin, is exactly "${a.url}".`;
  if (a.value !== undefined)
    return `On the final page, ${target(a.value.locator)} has the value "${a.value.equals}"${a.value.equals === '' ? ' (empty)' : ''}.`;
  if (a.noConsoleErrors === true) return 'No console error was logged on any page during the flow.';
  throw new Error(`assertion kind not rendered: ${JSON.stringify(a)}`);
}

/**
 * The full prompt for one LLM-arm run.
 *
 * @param flow - the parsed flow YAML.
 * @param base - the fixture's base URL for this run.
 * @param uid - the unique tag that replaces `{{uid}}`.
 */
export function promptFor(flow, base, uid) {
  const steps = stepLines(flow, base, uid).map((l, i) => `${i + 1}. ${l}`);
  const checks = (flow.assertions ?? []).map((a, i) => `${i + 1}. ${expectation(a, uid)}`);
  return [
    'You are verifying one user flow of a web app in a browser, with the Chrome DevTools tools only.',
    `The app runs at ${base}. To sign in as a role, open ${base}/login?as=<role> (it sets a cookie and redirects); the roles are employee and manager.`,
    `Goal of the flow (from its author, in the app's language): ${flow.goal}`,
    '',
    `First sign in as ${flow.profile}: open ${base}/login?as=${flow.profile}, then open ${base}${flow.start}.`,
    'Then do these steps, in order, exactly as written:',
    ...steps,
    '',
    'Then check every expectation below. Network expectations cover every request made during the whole flow;',
    'page expectations are about the page as it is after the last step.',
    ...checks,
    '',
    'Do not change anything the steps do not ask for. Check each expectation with the tools; do not assume.',
    'The flow PASSED only if every expectation holds; if any one does not hold, or a step cannot be done, it FAILED.',
    'End your answer with exactly one line, the last line, either `VERDICT: PASSED` or `VERDICT: FAILED`.',
  ].join('\n');
}

/**
 * The verdict on the last non-empty line of the agent's answer: `passed`, `failed` or `no_verdict`.
 *
 * @remarks Surrounding `*` or backticks (markdown emphasis) are tolerated; `strict` says whether the line was
 *   exactly `VERDICT: PASSED|FAILED`.
 */
export function parseVerdict(text) {
  const last = String(text ?? '')
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (last === undefined) return { verdict: 'no_verdict', strict: false };
  const m = /^[*`_\s]*VERDICT: (PASSED|FAILED)[*`_\s]*$/.exec(last);
  if (m === null) return { verdict: 'no_verdict', strict: false };
  return { verdict: m[1].toLowerCase(), strict: /^VERDICT: (PASSED|FAILED)$/.test(last) };
}
