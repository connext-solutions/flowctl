import {
  type CommandName,
  ConfigError,
  isCommand,
  type McpCommand,
  type TraceMode,
  TRUST_SUBCOMMANDS,
} from '@flowctl/core';
import type { parseArgs } from 'node:util';
import { USAGE } from './usage.js';

/** The options every command accepts; each command reads only its own. */
export const OPTIONS = {
  tag: { type: 'string' },
  env: { type: 'string' },
  repeat: { type: 'string', default: '1' },
  json: { type: 'boolean', default: false },
  headed: { type: 'boolean', default: false },
  heal: { type: 'boolean', default: false },
  'accept-heals': { type: 'boolean', default: false },
  trace: { type: 'string' },
  'trust-hooks': { type: 'boolean', default: false },
  'hook-env': { type: 'string', multiple: true },
  pin: { type: 'string', multiple: true },
  'anchor-dir': { type: 'string' },
  replace: { type: 'boolean', default: false },
  config: { type: 'string' },
} as const;

/** The parsed values of {@link OPTIONS}. */
export type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS }>
>['values'];

/** Trust subcommands whose next word names the command too: `trust add env`, `trust key rotate-owner`. */
const GROUPS = new Set(['add', 'key']);

/** The registered command named by the positionals, and its own arguments. */
export function resolve(positionals: string[]): {
  name: string;
  args: string[];
} {
  const [command = '', sub, ...rest] = positionals;
  if (command !== 'trust')
    return {
      name: command,
      args: sub === undefined ? [] : [sub, ...rest],
    };
  if (sub !== undefined && GROUPS.has(sub)) {
    const [kind = '', ...args] = rest;
    return { name: `trust ${sub} ${kind}`, args };
  }
  return { name: `trust ${sub ?? ''}`, args: rest };
}

/**
 * Prints why `positionals` is not a command and returns exit code 2. A reserved trust subcommand that is not built
 * yet says so; any other word after `trust` may be a flow name from the removed `trust <name>` form, so it names
 * `trust hook`.
 */
export function usageError(name: string, positionals: string[]): number {
  const [command, sub, kind] = positionals;
  let text = USAGE;
  if (command === 'trust' && sub !== undefined && !isCommand(name)) {
    if (GROUPS.has(sub)) {
      if (kind !== undefined)
        text = `flowctl: "trust ${sub} ${kind}" is not available yet.\n${USAGE}`;
    } else if (TRUST_SUBCOMMANDS.includes(sub))
      text = `flowctl: "trust ${sub}" is not available yet.\n${USAGE}`;
    else
      text = `flowctl: "trust ${sub}" is not a trust subcommand; to consent to a flow's hooks run: flowctl trust hook ${sub}`;
  }
  process.stderr.write(`${text}\n`);
  return 2;
}

/** A registered command the CLI runs: every command but `--help` and the MCP tools. */
export type Runnable = Exclude<CommandName, '--help' | McpCommand>;

/** Accepted argument counts per command, checked before the guard so a typo is a usage error. */
export const ARITY: Record<Runnable, (n: number) => boolean> = {
  replay: () => true,
  login: (n) => n === 1,
  'trust init': (n) => n === 0,
  'trust hook': (n) => n > 0,
  'trust add env': (n) => n === 1,
  'trust add profile': (n) => n === 3,
  'trust add project': (n) => n <= 1,
  'trust add default-env': (n) => n === 1,
  'trust add language': (n) => n === 1,
  'trust add locale': (n) => n === 1,
  'trust add production-origin': (n) => n === 1,
  'trust key rotate-owner': (n) => n === 0,
  'trust add system1': (n) => n >= 3,
  'trust add origin': (n) => n === 3,
};

/** True when `name` is a registered command the CLI runs (not `--help`, not an MCP tool). */
export const isRunnable = (name: string): name is Runnable =>
  Object.hasOwn(ARITY, name);

/**
 * The trace mode `--trace` names (ADR 0030): `safe` (the default when left out) or `full`. A full trace holds
 * cookies, request bodies and page content, so the CLI says so on stderr.
 *
 * @throws {ConfigError} for any other value.
 */
export function traceMode(value: string | undefined): TraceMode | undefined {
  if (value === undefined || value === 'safe') return value;
  if (value !== 'full')
    throw new ConfigError(
      `--trace must be safe or full, not ${JSON.stringify(value)}`,
    );
  process.stderr.write(
    'flowctl: --trace full records cookies, request bodies and page content in trace-*.zip; do not attach those traces to a bug or share them.\n',
  );
  return value;
}
