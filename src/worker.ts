/**
 * MCP over Streamable HTTP, on Cloudflare Workers. What `mcp.rifts.to` runs.
 *
 * **Transport choice.** The SDK ships two Streamable HTTP server transports.
 * `StreamableHTTPServerTransport` is written against Node's `IncomingMessage`
 * and `ServerResponse`, so it needs `nodejs_compat` and a shim layer that would
 * be load-bearing but never exercised by a test — a build that type-checks and
 * then fails on the first real request. Its own implementation delegates to
 * `WebStandardStreamableHTTPServerTransport`, which is written against
 * `Request`/`Response`/`ReadableStream` and is documented for Workers, so this
 * file uses that one directly and hand-rolls nothing. Writing a bespoke
 * fetch-shaped transport was the other option and was rejected for the same
 * reason: the SDK's version already handles Accept negotiation, protocol
 * version checks and batched messages, and a reimplementation would drift from
 * the spec the moment the spec moved.
 *
 * **Stateless, one server object per request.** Every caller presents a
 * different bearer token, and a Worker isolate is shared between callers, so a
 * long-lived `McpServer` would have to hold a token from some earlier request.
 * Building the server and transport per request makes that impossible by
 * construction. It costs a session: there is no `Mcp-Session-Id`, no `GET /mcp`
 * notification stream, and no resumability. All four tools are plain
 * request/response, so nothing here has a use for any of that.
 *
 * **No secrets, no bindings.** The Worker never sees a credential of its own.
 * It reads the caller's bearer token, hands it to `/api/v1`, and turns the
 * API's 401 back into a `WWW-Authenticate` challenge. Token validation happens
 * in exactly one place, and compromising this Worker yields nothing that was
 * not already presented to it.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DEFAULT_BASE_URL, RiftsClient } from "./client.js";
import { createServer } from "./server.js";

export interface Env {
  /** Overridable so a preview deployment can be pointed at a preview API. */
  RIFTS_API_URL?: string;
}

const MCP_PATH = "/mcp";

/**
 * RFC 9728 fixes this path for a resource identified by a bare origin. The
 * `resource` this document advertises is the origin with no path, which is what
 * makes that the right URL — and it is also the audience value `/api/v1`
 * accepts for tokens minted for this server, so the two must not drift.
 */
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** rifts.to is the authorization server: it is where accounts and D1 live. */
const AUTHORIZATION_SERVER = "https://rifts.to";

const SCOPES = ["surveys:read", "surveys:write"];

/**
 * A wildcard origin is safe here only because this Worker has no ambient
 * authority: no cookies, no bindings, and every request is authorized by a
 * bearer token the caller had to already hold. A browser page that reaches this
 * endpoint gains nothing it could not get with `curl`.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  // Without this the browser hides both headers from the page: the session id a
  // stateful client would need, and the challenge that starts the OAuth flow.
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === RESOURCE_METADATA_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD, OPTIONS");
      }
      return resourceMetadata(url, env);
    }

    if (url.pathname === MCP_PATH) {
      if (request.method !== "POST") {
        // 405 rather than 404: a client probing `GET /mcp` for the optional
        // server-initiated stream must learn that this server does not offer
        // one, not that it typed the URL wrong.
        return methodNotAllowed("POST, OPTIONS");
      }
      return handleMcp(request, env, url);
    }

    return json({ error: "not found" }, 404);
  },
};

/**
 * RFC 9728 metadata. Everything is derived rather than baked in, so one build
 * is correct on workers.dev and on mcp.rifts.to without a config change that
 * somebody has to remember.
 *
 * `authorization_servers` follows `RIFTS_API_URL` rather than being pinned to
 * production, because the rifts.to deployment this server talks to *is* its
 * authorization server. Pinning them apart is how a preview build ends up
 * telling clients to go and authorize somewhere that does not know about it.
 */
function resourceMetadata(url: URL, env: Env): Response {
  const authorizationServer = env.RIFTS_API_URL?.trim() || AUTHORIZATION_SERVER;

  return json(
    {
      resource: url.origin,
      authorization_servers: [authorizationServer.replace(/\/$/, "")],
      scopes_supported: SCOPES,
      // OAuth 2.1 and the MCP spec both forbid a token in a query string, and
      // this server reads only the header. Saying so is not decoration: it is
      // the machine-readable half of that rule.
      bearer_methods_supported: ["header"],
    },
    200,
    {
      // Metadata that rarely changes, but a stale copy sends a client to the
      // wrong authorization server, so keep the window short.
      "Cache-Control": "public, max-age=3600",
    }
  );
}

async function handleMcp(request: Request, env: Env, url: URL): Promise<Response> {
  const token = bearerToken(request.headers.get("Authorization"));
  if (!token) return unauthorized(url, "no bearer token was presented");

  const baseUrl = env.RIFTS_API_URL?.trim() || DEFAULT_BASE_URL;

  // Validate before serving anything.
  //
  // The reactive check below only trips when a tool actually calls the API, and
  // `initialize` and `tools/list` never do. Without this, a request carrying a
  // revoked or expired token got a cheerful 200 listing four tools, so a client
  // sat there looking connected and only discovered the problem on the first
  // tool call, as an error message rather than as the 401 that would have made
  // it refresh. For an OAuth client the 401 *is* the signal, so it has to come
  // before the work, not after.
  //
  // The cost is one edge-to-edge request per call. These are conversational
  // volumes, not /api/respond volumes, and correctness here is worth more than
  // the round trip.
  const probe = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (probe.status === 401) {
    return unauthorized(url, "the rifts.to API rejected the token", "invalid_token");
  }
  if (probe.status === 403) {
    // Entitlement, not authentication. A challenge would send the client round
    // the OAuth loop again to arrive at the same place, so say what is wrong
    // instead: this needs a subscription, not a fresh token.
    return json(
      {
        error: "insufficient_scope",
        error_description:
          "this rifts.to account does not have an active subscription",
      },
      403
    );
  }

  // The API is the only thing that can tell a live token from a dead one, so
  // "was this token rejected" is observed at the fetch layer rather than
  // guessed at. A tool call that 401s is not a tool failure the model should
  // apologise for; it is an expired credential, and the client can only know to
  // re-authenticate if it gets the challenge as an HTTP status.
  let tokenRejected = false;
  const client = new RiftsClient({
    baseUrl,
    token,
    fetchImpl: async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 401) tokenRejected = true;
      return response;
    },
  });

  const server = createServer(client);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session to resume and nowhere to keep one. See the header.
    sessionIdGenerator: undefined,
    // Plain JSON rather than an SSE frame per response. Nothing here streams,
    // and a resolved Response (as opposed to a stream the isolate must stay
    // alive to feed) is also what lets the 401 check below run before anything
    // has been sent.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);

    if (tokenRejected) {
      return unauthorized(url, "the rifts.to API rejected the token", "invalid_token");
    }

    return withCors(response);
  } catch (error) {
    // A throw out of the transport is this server's bug, not the caller's, and
    // it still has to come back as JSON-RPC or the client reports a transport
    // error with nothing in it.
    return json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: message(error) },
        id: null,
      },
      500
    );
  } finally {
    // In JSON mode the body is fully materialised before handleRequest
    // resolves, so closing here cannot truncate a response in flight.
    await server.close().catch(() => {});
  }
}

/**
 * The `resource_metadata` parameter is the whole point of this response: it is
 * what tells a client where to look up the authorization server, and a client
 * that cannot parse it simply never offers to sign in. RFC 9728 quotes the
 * value, so it is quoted here.
 *
 * `error` is omitted when nothing was presented at all, per RFC 6750: an
 * `invalid_token` code on a request that carried no token tells a client its
 * stored credential was rejected, which would send it to refresh a token it
 * never sent.
 */
function unauthorized(url: URL, detail: string, code?: "invalid_token"): Response {
  const params = [
    `realm="rifts.to"`,
    ...(code ? [`error="${code}"`] : []),
    `error_description="${detail}"`,
    `resource_metadata="${url.origin}${RESOURCE_METADATA_PATH}"`,
  ];

  return json({ error: code ?? "unauthorized", error_description: detail }, 401, {
    "WWW-Authenticate": `Bearer ${params.join(", ")}`,
  });
}

/**
 * Only the `Bearer` scheme, and the scheme name compared case-insensitively
 * because RFC 7235 says it is. Anything else is treated as no token at all, so
 * a client sending Basic credentials gets the challenge rather than a 500.
 */
function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method not allowed" }, 405, { Allow: allow });
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

/** The transport builds its own Response, so CORS has to be added afterwards. */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
