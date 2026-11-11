import {
  ConfigError,
  effectiveConfig,
  Exploration,
  findFlowsWithErrors,
  FlowError,
  type LoadedConfig,
  MCP_TOOLS,
  parseExploreRequest,
  replayMany,
  requireTrust,
  RunError,
  saveExploration,
  TrustError,
  type TrustStore,
} from '@flowctl/core';
import { McpServer } from '@modelcontextprotocol/server';
import type { Browser } from 'playwright';
import { z } from 'zod';
import { Runs } from './runs.js';
import { progressView, replayView } from './shape.js';
import { DOCS, type McpTool } from './docs.js';

/** What the server needs from its caller; the bin passes the owner's default store, a test an injected one. */
export interface ServerDeps {
  /** The repo config as read; each tool call intersects it with the store again. */
  cfg: LoadedConfig;
  openStore: () => TrustStore | undefined;
  browser: () => Promise<Browser>;
  version: string;
  /** Where background failures go (a sweep or an operation nobody waits for); the bin writes them to stderr. */
  onError?: (e: unknown) => void;
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (v: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(v) }],
  structuredContent: v,
});

/** A refusal the orchestrator can act on; anything else is a bug and propagates. */
function refusal(e: unknown): ToolResult {
  if (e instanceof TrustError || e instanceof RunError)
    return {
      content: [{ type: 'text', text: `${e.kind}: ${e.message}` }],
      isError: true,
    };
  if (e instanceof FlowError || e instanceof ConfigError)
    return { content: [{ type: 'text', text: e.message }], isError: true };
  throw e;
}

const Records = z.array(z.record(z.string(), z.unknown()));

/**
 * What every tool call runs with: the store it was checked against and the config intersected with that store on
 * this call (ADR 0024 section 1), so an owner change to the store applies to the next `flow_run`, `flow_save` and
 * `flow_replay`.
 *
 * @remarks An exploration keeps the config and store it started with: `flow_step` and `flow_wait` do not narrow it
 *   again (a run is bounded by `maxSteps`). They still run the guard, so a store that no longer verifies, or no
 *   longer registers the project, refuses them too.
 */
interface Guarded {
  store: TrustStore;
  cfg: LoadedConfig;
}

/**
 * The flowctl MCP server for one project: the five tools of ADR 0012, each guarded by the trust store (ADR 0025
 * section 3) before any side effect. Exploration state lives in {@link Runs}; replay launches its own browser.
 *
 * @remarks Exploration inputs are typed values only (`{ value }`): a secret `{ env }` input is not accepted over
 *   MCP (an agent must not choose which host variable a run reads); use a saved flow, whose `{ env }` names the
 *   trust store allows (T1.14), with `flow_replay`. `flow_save` and
 *   `flow_replay` are not bounded by the 55 s wait: a long replay can outlast a client's request timeout, and it
 *   still runs to the end.
 * @see docs/adr/0012-mcp-for-explore-cli-for-replay.md
 * @see docs/adr/0027-mcp-server-package.md
 */
export function createServer(deps: ServerDeps): {
  server: McpServer;
  runs: Runs<Exploration>;
  close: () => Promise<void>;
} {
  const runs = new Runs<Exploration>(deps.onError);
  const server = new McpServer({ name: 'flowctl', version: deps.version });
  const guard = (): Guarded => {
    const trusted = requireTrust(deps.openStore(), {
      projectDir: deps.cfg.root,
      flowsDir: deps.cfg.flowsPath,
    });
    return {
      store: trusted.store,
      cfg: effectiveConfig(deps.cfg, trusted).cfg,
    };
  };
  const tool = <A>(
    name: McpTool,
    inputSchema: z.ZodType<A>,
    run: (a: A, g: Guarded) => Promise<Record<string, unknown>>,
  ): void => {
    if (!MCP_TOOLS.includes(name))
      throw new FlowError(`MCP tool ${name} is not in the command registry`);
    server.registerTool(
      name,
      { description: DOCS[name], inputSchema },
      async (a: A) => {
        try {
          return ok(await run(a, guard()));
        } catch (e) {
          return refusal(e);
        }
      },
    );
  };

  tool(
    'flow_run',
    z.object({
      goal: z.string(),
      start: z.string(),
      profile: z.string(),
      assertions: Records.min(1),
      inputs: z.record(z.string(), z.object({ value: z.string() })).optional(),
      maxSteps: z.number().int().optional(),
      allowDestructive: z.boolean().optional(),
      envName: z.string().optional(),
    }),
    async ({ envName, ...req }, { store, cfg }) => {
      const release = runs.reserve();
      let x: Exploration;
      try {
        x = await Exploration.start(cfg, parseExploreRequest(req), {
          env: envName,
          browser: await deps.browser(),
          store,
        });
        runs.add(x);
      } finally {
        release();
      }
      return progressView(await runs.drive(x.runId, (r) => r.advance()));
    },
  );

  tool(
    'flow_step',
    z.object({
      runId: z.string(),
      steps: Records.optional(),
      hint: z.string().optional(),
      finish: z.boolean().optional(),
    }),
    async ({ runId, steps, hint, finish }) => {
      if (finish === true && (steps !== undefined || hint !== undefined))
        throw new FlowError(
          'finish ends the run now; send it without steps or hint.',
        );
      return progressView(
        await runs.drive(runId, (x) => {
          if (hint !== undefined) x.hint(hint);
          if (finish === true) return x.finish();
          return steps === undefined ? x.advance() : x.step(steps);
        }),
      );
    },
  );

  tool('flow_wait', z.object({ runId: z.string() }), async ({ runId }) =>
    progressView(await runs.wait(runId)),
  );

  tool(
    'flow_save',
    z.object({
      runId: z.string(),
      name: z.string(),
      tags: z.array(z.string()).optional(),
    }),
    async ({ runId, name, tags }, { store, cfg }) => {
      const browser = await deps.browser();
      const r = await runs.exclusive(runId, (x) =>
        saveExploration(cfg, x, { name, tags, browser, store }),
      );
      if (r.saved) runs.forget(runId);
      return {
        saved: r.saved,
        ...(r.file === undefined ? {} : { file: r.file }),
        replay: progressView(r.replay),
      };
    },
  );

  tool(
    'flow_replay',
    z.object({
      names: z.array(z.string()).optional(),
      tag: z.string().optional(),
      envName: z.string().optional(),
      repeat: z.number().int().min(1).max(5).optional(),
      video: z.boolean().optional(),
    }),
    async ({ names, tag, envName, repeat, video }, { store, cfg }) => {
      const { flows, errors } = findFlowsWithErrors(
        cfg.flowsPath,
        Object.keys(cfg.profiles),
        { names, tag },
      );
      if (flows.length === 0 && errors.length === 0)
        throw new FlowError(`No flows matched in ${cfg.flowsPath}`);
      const summary =
        flows.length === 0
          ? undefined
          : await replayMany(cfg, flows, {
              env: envName,
              repeat,
              store,
              video,
            });
      return {
        ...(summary === undefined ? {} : replayView(summary)),
        invalidFiles: errors.map((e) => e.message),
      };
    },
  );

  return { server, runs, close: () => runs.closeAll() };
}
