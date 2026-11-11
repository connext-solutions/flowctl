#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  ConfigError,
  effectiveConfig,
  loadConfig,
  openTrustStore,
  requireTrust,
  TrustError,
} from '@flowctl/core';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { type Browser, chromium } from 'playwright';
import { createServer } from './server.js';

const VERSION = '0.2.0';
const SWEEP_MS = 60_000;

const USAGE = `Usage: flowctl-mcp [--config <path>] [--headed]

An MCP server on stdio for coding agents: explore a flow with System 1 (flow_run, flow_step, flow_wait),
save it (flow_save) and replay saved flows (flow_replay). Run it from your MCP client, e.g.
  claude mcp add flowctl -- node <flowctl>/packages/mcp/dist/bin.js --config <project>/flowctl.config.yaml
Needs this machine's trust store with the project registered: run flowctl trust init first.`;

/**
 * Starts the server and resolves once the client disconnects.
 *
 * @returns the exit code: 0 after a clean disconnect or `--help`, 2 for a usage or config error, 3 when the
 *   trust store refuses the project.
 */
async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        config: { type: 'string' },
        headed: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    process.stderr.write(`flowctl-mcp: ${String(e)}\n${USAGE}\n`);
    return 2;
  }
  let cfg;
  try {
    const loaded = loadConfig(values.config);
    const effective = effectiveConfig(
      loaded,
      requireTrust(openTrustStore(), {
        projectDir: loaded.root,
        flowsDir: loaded.flowsPath,
      }),
    );
    for (const w of effective.warnings)
      process.stderr.write(`flowctl-mcp: warning: ${w}\n`);
    cfg = loaded;
  } catch (e) {
    if (e instanceof TrustError) {
      process.stderr.write(`flowctl-mcp: ${e.kind}: ${e.message}\n`);
      return 3;
    }
    if (e instanceof ConfigError) {
      process.stderr.write(`flowctl-mcp: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  let browser: Promise<Browser> | undefined;
  const launch = (): Promise<Browser> => {
    const p = chromium
      .launch({ headless: values.headed !== true })
      .then((b) => {
        b.on('disconnected', () => {
          if (browser === p) browser = undefined;
        });
        return b;
      });
    p.catch(() => {
      if (browser === p) browser = undefined;
    });
    return p;
  };
  const report = (e: unknown): void => {
    process.stderr.write(
      `flowctl-mcp: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  };
  const { server, runs, close } = createServer({
    cfg,
    openStore: openTrustStore,
    browser: () => (browser ??= launch()),
    version: VERSION,
    onError: report,
  });
  const sweeper = setInterval(() => void runs.sweep(), SWEEP_MS);
  sweeper.unref();
  const stopped = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    process.stdin.once('end', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await server.connect(new StdioServerTransport());
  await stopped;
  clearInterval(sweeper);
  await close();
  await browser?.then((b) => b.close()).catch(report);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`flowctl-mcp: ${String(e)}\n`);
    process.exitCode = 2;
  },
);
