import { createInterface } from 'node:readline/promises';
import type { LoginOptions } from '@flowctl/core';

type LoginPage = Parameters<LoginOptions['waitForUser']>[0];

/**
 * Resolves once the user has logged in: Enter in an interactive terminal, or closing the browser
 * window.
 *
 * @remarks Without a TTY (an agent's `!` shell, CI) stdin is never read, so only closing the
 *   window finishes; reading a closed stdin used to crash with `ERR_USE_AFTER_CLOSE`.
 */
export async function waitForLogin(page: LoginPage): Promise<void> {
  const closed = page.waitForEvent('close', { timeout: 0 });
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'Log in in the browser window, then close the window to save the session...\n',
    );
    await closed;
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ac = new AbortController();
  try {
    await Promise.race([
      rl
        .question(
          'Log in in the browser window, then press Enter here (or close the window) to save the session... ',
          { signal: ac.signal },
        )
        .catch(() => undefined),
      closed,
    ]);
  } finally {
    ac.abort();
    rl.close();
  }
}
