import { expect, it } from 'vitest';
import { buildRequest } from '../src/system1/index.js';
import { goldenInput } from './system1-golden/golden-input.js';

/**
 * The exact request flowctl sends to System 1 for a representative page, frozen in a file.
 *
 * @remarks Prompts and question wording steer a model we do not control. Any change to
 *   `system1/prompts.ts` or `protocol.ts` shows up here as a diff of `__golden__/system1-request.json`;
 *   update it with `bun run test -- -u packages/core/test/system1.golden.test.ts` only on purpose, and run
 *   the contract tier before merging (`.claude/rules/system1.md`).
 */
it('sends the frozen System 1 request', async () => {
  const { body, offered } = buildRequest(goldenInput, 'jev-latest');
  expect(JSON.stringify(body)).not.toContain('mat-khau-123');
  await expect(
    `${JSON.stringify({ offered, body }, null, 2)}\n`,
  ).toMatchFileSnapshot('__golden__/system1-request.json');
});
