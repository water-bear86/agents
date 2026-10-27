import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMcpHttp } from "./http.js";

const KEY = `ak_${"cd".repeat(24)}`;

/** The REST API the tools call: records what reached it. */
const calls: { url: string; auth?: string; body?: any }[] = [];
const api = (async (url: string, init?: RequestInit) => {
  calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.endsWith("/actions")) return Response.json({ results: [{ ok: true }] });
  return Response.json({ agents: [{ handle: "atlas", progress: { level: 2 } }] });
}) as unknown as typeof fetch;

let http: Server;
let url: URL;
beforeAll(async () => {
  http = createHttpServer(async (req, res) => {
    let d = "";
    for await (const c of req) d += c;
    await handleMcpHttp(req, res, { api: "http://runtime", authenticate: (k) => (k === KEY ? { handle: "atlas" } : null), body: d ? JSON.parse(d) : undefined, fetch: api });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
});
afterAll(() => new Promise<void>((ok) => http.close(() => ok())));

async function connect(key?: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : undefined }));
  return client;
}
const textOf = (r: any) => JSON.parse(r.content[0].text);

describe("hosted MCP endpoint", () => {
  it("serves the agent's tools and acts with its key", async () => {
    const c = await connect(KEY);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["my_agent", "turn", "post", "buy", "launch", "projects"]));
    expect(names).not.toContain("bounties");
    expect(textOf(await c.callTool({ name: "post", arguments: { body: "first light over the quarter" } }))).toEqual({ results: [{ ok: true }] });
    const sent = calls.at(-1)!;
    expect(sent.url).toBe("http://runtime/v1/agents/atlas/actions");
    expect(sent.auth).toBe(`Bearer ${KEY}`);
    expect(sent.body.actions).toEqual([{ type: "post", body: "first light over the quarter" }]);
    await c.close();
  });

  it("lets anyone without a key read the town, but not act", async () => {
    const c = await connect();
    expect(textOf(await c.callTool({ name: "town", arguments: {} }))[0].handle).toBe("atlas");
    const before = calls.length;
    expect(textOf(await c.callTool({ name: "post", arguments: { body: "hello" } })).error).toMatch(/no agent connected/);
    expect(calls.slice(before).some((x) => x.url.endsWith("/actions"))).toBe(false);
    await c.close();
  });

  it("refuses a key that doesn't belong to an agent", async () => {
    await expect(connect("ak_wrong")).rejects.toThrow(/401|bad api key/);
  });

  it("is stateless: GET and DELETE are not allowed", async () => {
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
  });
});
