import { TrustError } from './errors.js';
import { flowsRootFor, projectFor } from './registry.js';
import type { TrustStore } from './store.js';

/**
 * Every command flowctl offers, and whether it is guarded (ADR 0025 section 3, "Guarded commands"). A guarded
 * command refuses with `trust_missing` before any side effect when the store, the project entry or the flows
 * root is missing. Unguarded are only commands that run no browser, no shell and no network call and write
 * nothing but the store. A new command is added here with its flag; the CLI dispatches only names listed here,
 * and a test pins the unguarded set exactly.
 *
 * A `storeOnly` command needs the store but not this project's entry: `trust add project` is how a checkout gets
 * one.
 *
 * @remarks `--version` and `trust verify-bundle` are unguarded in the ADR but do not exist yet. Every MCP tool
 *   is listed here as `mcp <tool>`, guarded with no exception; the MCP server registers exactly these tools.
 * @see docs/adr/0025-trust-store.md
 */
export const COMMANDS = {
  '--help': { guarded: false },
  replay: { guarded: true },
  login: { guarded: true },
  cleanup: { guarded: true },
  observe: { guarded: true },
  reconcile: { guarded: true },
  'trust init': { guarded: false },
  'trust hook': { guarded: true },
  'trust add env': { guarded: true },
  'trust add profile': { guarded: true },
  'trust add project': { guarded: true, storeOnly: true },
  'trust add default-env': { guarded: true },
  'trust add language': { guarded: true },
  'trust add locale': { guarded: true },
  'trust add production-origin': { guarded: true },
  'trust add system1': { guarded: true },
  'trust add origin': { guarded: true },
  'trust key rotate-owner': { guarded: true, storeOnly: true },
  'trust key new': { guarded: true, storeOnly: true },
  'trust key add': { guarded: true, storeOnly: true },
  'trust key revoke': { guarded: true, storeOnly: true },
  'trust add destructive': { guarded: true },
  'trust revoke destructive': { guarded: true },
  'mcp flow_run': { guarded: true },
  'mcp flow_step': { guarded: true },
  'mcp flow_wait': { guarded: true },
  'mcp flow_save': { guarded: true },
  'mcp flow_replay': { guarded: true },
} as const satisfies Record<string, { guarded: boolean; storeOnly?: true }>;

/** The name of a registered command, e.g. `replay`, `trust add env` or `mcp flow_run`. */
export type CommandName = keyof typeof COMMANDS;

/** A registered MCP tool, e.g. `mcp flow_run`. */
export type McpCommand = Extract<CommandName, `mcp ${string}`>;

/** The MCP tool names of the registry, without the `mcp ` prefix. */
export const MCP_TOOLS: readonly string[] = Object.keys(COMMANDS)
  .filter((n) => n.startsWith('mcp '))
  .map((n) => n.slice(4));

/** True when `name` is a registered command. */
export const isCommand = (name: string): name is CommandName =>
  Object.hasOwn(COMMANDS, name);

/** A guarded command's view of the store: the verified project and the store itself. */
export interface Trusted {
  store: TrustStore;
  project: string;
}

/**
 * The check every guarded command runs first: a store exists, and this checkout and its flows directory are
 * registered in it with owner-signed entries.
 *
 * @throws {TrustError} `trust_missing` (detail `no_store`, `no_project` or `no_flows_root`) with the command
 *   that fixes it; `trust_tampered` for an entry that is not owner-signed.
 */
export function requireTrust(
  store: TrustStore | undefined,
  t: { projectDir: string; flowsDir: string },
): Trusted {
  if (store === undefined)
    throw new TrustError(
      'trust_missing',
      'There is no trust store on this machine. Run: flowctl trust init',
      'no_store',
    );
  const project = projectFor(store, t.projectDir);
  if (project === undefined)
    throw new TrustError(
      'trust_missing',
      `The project at ${t.projectDir} is not registered in the trust store at ${store.dir}. Register it with: flowctl trust add project`,
      'no_project',
    );
  if (flowsRootFor(store, t.flowsDir, t.projectDir) === undefined)
    throw new TrustError(
      'trust_missing',
      `The flows directory ${t.flowsDir} is not the one registered for project "${project}". Point flowsDir back to it, or remove ${store.dir} and run: flowctl trust init`,
      'no_flows_root',
    );
  return { store, project };
}

/**
 * The check of a `storeOnly` guarded command: a store exists. The project need not be registered yet.
 *
 * @throws {TrustError} `trust_missing` (detail `no_store`) with the command that fixes it.
 */
export function requireStore(store: TrustStore | undefined): TrustStore {
  if (store === undefined)
    throw new TrustError(
      'trust_missing',
      'There is no trust store on this machine. Run: flowctl trust init',
      'no_store',
    );
  return store;
}
