#!/usr/bin/env node
/**
 * The `rifts-mcp` executable: MCP over stdio, credentials from the
 * environment.
 *
 * Taking the token from `RIFTS_TOKEN` rather than running an OAuth flow is
 * what the MCP specification asks of a stdio server, not a shortcut — a
 * process with no browser and no redirect URI has nowhere to run one.
 *
 * **stdout belongs to the protocol.** A single stray byte written to it — a
 * banner, a `console.log`, a stray `process.stdout.write` from a dependency —
 * lands in the middle of the JSON-RPC stream and the client fails with an
 * opaque parse error that points at nothing. Everything diagnostic goes to
 * stderr, which clients collect as logs.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BASE_URL, RiftsClient } from "./client.js";
import { createServer } from "./server.js";

// Belt and braces for the rule above: anything that reaches for console.log,
// here or in a dependency, is redirected to stderr instead of corrupting the
// stream. Cheaper than diagnosing it later from a client-side parse error.
console.log = console.error;

async function main(): Promise<void> {
  const token = process.env.RIFTS_TOKEN?.trim();
  if (!token) {
    console.error(
      [
        "rifts-mcp: RIFTS_TOKEN is not set.",
        "",
        "Create a personal access token at https://rifts.to/en/account (API tokens),",
        "then pass it to this server in the environment, e.g.:",
        "",
        '  "env": { "RIFTS_TOKEN": "rifts_pat_..." }',
      ].join("\n")
    );
    process.exit(1);
  }

  const baseUrl = process.env.RIFTS_API_URL?.trim() || DEFAULT_BASE_URL;

  const server = createServer(new RiftsClient({ baseUrl, token }));

  // The token is never logged, here or anywhere else — the base URL is the
  // only part of the configuration that is safe to echo.
  console.error(`rifts-mcp ready (api: ${baseUrl})`);

  await server.connect(new StdioServerTransport());

  // A client disconnecting closes stdin; exit rather than linger as an orphan.
  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`rifts-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
