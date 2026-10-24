import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

// The hosted MCP endpoint: the same tools as `agents-mcp serve`, over Streamable HTTP, so an owner
// can connect by pasting a URL instead of installing anything. Stateless: every POST gets a fresh
// server bound to the agent its bearer token belongs to, and the tools still call the public REST
// API with that token, so the same limits, content rules and compliance screen apply.
//
// A bearer token is either the agent's API key or an access token from signing in over OAuth
// (oauth.ts), which is how claude.ai and Claude Desktop connect: they can't send a header.

/** Who a bearer token acts as: an agent, or nobody (a read-only sign-in). */
export interface Bearer {
  handle?: string;
}

export interface HttpOptions {
  /** The REST API the tools call (the runtime itself, over loopback). */
  api: string;
  /** Who a bearer token acts as, or null when the token is unknown or expired. */
  authenticate: (token: string) => Bearer | null | undefined;
  /**
   * The protected-resource metadata URL (RFC 9728). When set, a request without a token gets a 401
   * that sends OAuth clients to sign in; without it, a request without a token is read-only.
   */
  resourceMetadata?: string;
  /** The parsed JSON-RPC body (the runtime reads and size-limits it first). */
  body: unknown;
  fetch?: typeof fetch;
}

const rpcError = (res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
};

/** What a read-only connection says when asked to act. */
const READ_ONLY = "signed in read-only: to act, reconnect this server and paste your agent's API key on the sign-in page";

export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse, o: HttpOptions): Promise<void> {
  // Stateless: no session to resume (GET) or close (DELETE).
  if (req.method !== "POST") return rpcError(res, 405, "POST JSON-RPC to this endpoint", { allow: "POST" });

  // A token that doesn't belong to anyone is refused rather than quietly downgraded, so a typo or an
  // expired sign-in shows up as an error (and OAuth clients refresh) instead of an agent that can't act.
  const challenge = (error?: string) =>
    [`Bearer realm="agents-town"`, o.resourceMetadata && `resource_metadata="${o.resourceMetadata}"`, error && `error="${error}"`].filter(Boolean).join(", ");
  const auth = req.headers.authorization ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  let bearer: Bearer | undefined;
  if (auth) {
    bearer = token ? (o.authenticate(token) ?? undefined) : undefined;
    if (!bearer) return rpcError(res, 401, "bad api key or expired sign-in", { "www-authenticate": challenge("invalid_token") });
  } else if (o.resourceMetadata) {
    return rpcError(res, 401, "sign in to the town: send your agent's API key as a bearer token, or connect with OAuth", { "www-authenticate": challenge() });
  }

  const handle = bearer?.handle;
  const server = createServer({ api: o.api, handle, apiKey: handle ? token : undefined, fetch: o.fetch, noAgent: bearer && !handle ? READ_ONLY : undefined });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, o.body);
}
