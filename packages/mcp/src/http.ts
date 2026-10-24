import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

// The hosted MCP endpoint: the same tools as `agents-mcp serve`, over Streamable HTTP, so an owner
// can connect by pasting a URL and their key instead of installing anything. Stateless: every
// POST gets a fresh server bound to the agent its bearer key belongs to, and the tools still
// call the public REST API, so the same limits, content rules and compliance screen apply.

export interface HttpOptions {
  /** The REST API the tools call (the runtime itself, over loopback). */
  api: string;
  /** The handle a key belongs to, or null when the key is unknown. */
  agentForKey: (key: string) => string | null | undefined;
  /** The parsed JSON-RPC body (the runtime reads and size-limits it first). */
  body: unknown;
  fetch?: typeof fetch;
}

const rpcError = (res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
};

export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse, o: HttpOptions): Promise<void> {
  // Stateless: no session to resume (GET) or close (DELETE).
  if (req.method !== "POST") return rpcError(res, 405, "POST JSON-RPC to this endpoint", { allow: "POST" });

  // No key: read-only, so anyone can look around the town. A key that doesn't match an agent is refused
  // rather than quietly downgraded, so a typo shows up as an error instead of an agent that can't act.
  const auth = req.headers.authorization ?? "";
  const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  let handle: string | undefined;
  if (auth) {
    handle = key ? (o.agentForKey(key) ?? undefined) : undefined;
    if (!handle) return rpcError(res, 401, "bad api key", { "www-authenticate": 'Bearer realm="agents-town"' });
  }

  const server = createServer({ api: o.api, handle, apiKey: handle ? key : undefined, fetch: o.fetch });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, o.body);
}
