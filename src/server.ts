/**
 * Builds the MCP server. Transport-free on purpose: `stdio.ts` connects a
 * stdio transport to it, and the hosted deployment will connect an HTTP one to
 * the same object, so neither entry point can drift on which tools exist or
 * how they behave.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RiftsClient } from "./client.js";
import { registerTools } from "./tools.js";

/**
 * The protocol identifier, not the brand. Clients namespace tool names with it
 * (`mcp__rifts__create_survey`), so it stays a bare slug: a dot in here would
 * ride along into every tool name. `title` below is where "rifts.to" belongs.
 */
export const SERVER_NAME = "rifts";

/** Kept in step with package.json by hand; nothing imports JSON at runtime. */
export const SERVER_VERSION = "0.1.0";

export function createServer(client: RiftsClient): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "rifts.to MCP server",
    },
    {
      // Shown by clients that surface it, and the only place this server can
      // explain the account/subscription requirement before a tool call fails.
      instructions:
        "Create and read live audience surveys on rifts.to. create_survey returns a public link to share with respondents and an admin link that shows results in real time. Every call uses the account that owns the configured RIFTS_TOKEN, and requires that account to have an active rifts.to subscription.",
    }
  );

  registerTools(server, client);

  return server;
}

export { RiftsClient, RiftsApiError, DEFAULT_BASE_URL } from "./client.js";
export type {
  CreateSurveyInput,
  CreatedSurvey,
  Question,
  QuestionInput,
  RiftsClientOptions,
  SurveyResults,
  SurveySummary,
} from "./client.js";
