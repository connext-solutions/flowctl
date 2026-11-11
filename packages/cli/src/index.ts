import { openTrustStore } from '@flowctl/core';
import { runCli } from './main.js';

export { formatSummary } from './summary.js';

/**
 * The `flowctl` entry point: runs `argv` against the owner's trust store at its fixed location (ADR 0025
 * section 1) and returns the exit code. There is no way to name another store here.
 */
export function main(argv: string[]): Promise<number> {
  return runCli(argv, { openStore: openTrustStore });
}
