import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { main, snippets, type Io } from "./cli.js";
import { listAgents, loadAgent, resolve, saveAgent } from "./config.js";
import { createServer } from "./server.js";

const KEY = `ak_${"ab".repeat(24)}`;
const home = () => ({ AGENTS_MCP_HOME: mkdtempSync(join(tmpdir(), "agents-mcp-")) }) as NodeJS.ProcessEnv;

/** A fake runtime: records requests, answers registration and actions. */
function fakeApi() {
  const calls: { url: string; method: string; auth?: string; body?: any }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", auth: (init?.headers as Record<string, string> | undefined)?.authorization, body });
    if (url.endsWith("/v1/agents") && init?.method === "POST") {
      return body.handle === "taken" ? Response.json({ error: "bad or taken handle" }, { status: 400 }) : Response.json({ agent: { handle: body.handle }, apiKey: KEY }, { status: 201 });
    }
    if (url.includes("/v1/agents/ghost")) return Response.json({ error: "unknown agent" }, { status: 404 });
    if (url.endsWith("/actions")) return Response.json({ results: body.actions.map((a: unknown) => ({ action: a, ok: true })) });
    return Response.json({ agents: [] });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function io(env: NodeJS.ProcessEnv, fetch: typeof globalThis.fetch, secret = KEY) {
  const out: string[] = [], err: string[] = [];
  const x: Io = { out: (s) => out.push(s), err: (s) => err.push(s), secret: async () => secret, fetch, env };
  return { io: x, out, err };
}

describe("key store", () => {
  it("saves one file per agent, readable only by the owner", () => {
    const env = home();
    const file = saveAgent({ handle: "atlas", api: "http://x", apiKey: KEY, savedAt: 1 }, env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(loadAgent("atlas", env)?.apiKey).toBe(KEY);
    expect(loadAgent("../etc", env)).toBeNull();
    expect(() => saveAgent({ handle: "../x", api: "", apiKey: "", savedAt: 0 }, env)).toThrow();
  });

  it("resolves env vars first, then --agent, then the only saved agent", () => {
    const env = home();
    expect(resolve({}, env)).toMatchObject({ handle: undefined, problem: expect.stringMatching(/agents-mcp login/) });
    saveAgent({ handle: "atlas", api: "http://saved", apiKey: KEY, savedAt: 1 }, env);
    expect(resolve({}, env)).toMatchObject({ handle: "atlas", api: "http://saved", apiKey: KEY });
    saveAgent({ handle: "moss", api: "http://saved", apiKey: KEY, host: true, savedAt: 1 }, env);
    expect(resolve({}, env).problem).toMatch(/several agents/);
    expect(resolve({ agent: "moss" }, env)).toMatchObject({ handle: "moss", host: true });
    expect(resolve({ agent: "nope" }, env).problem).toMatch(/add nope/);
    expect(resolve({}, { ...env, AGENTS_HANDLE: "env", AGENTS_API_KEY: "k", AGENTS_API: "http://env", AGENTS_ROLE: "host" })).toEqual({ api: "http://env", handle: "env", apiKey: "k", host: true });
  });
});

describe("cli", () => {
  it("register creates an external agent and saves its key without printing it", async () => {
    const env = home();
    const api = fakeApi();
    const r = io(env, api.fetch);
    expect(await main(["register", "--handle", "atlas", "--persona", "calm", "--style", "sniper", "--api", "http://town/"], r.io)).toBe(0);
    expect(api.calls[0]).toMatchObject({ url: "http://town/v1/agents", method: "POST", body: { handle: "atlas", persona: "calm", style: "sniper", modelId: "external" } });
    expect(api.calls[0]!.body.managed).toBeUndefined();
    expect(loadAgent("atlas", env)).toMatchObject({ api: "http://town", apiKey: KEY });
    const printed = r.out.join("\n");
    expect(printed).not.toContain(KEY);
    expect(printed).toContain("claude mcp add --scope user town-atlas -- npx -y agents-mcp serve --agent atlas");
  });

  it("register reports the runtime's error and saves nothing", async () => {
    const env = home();
    const r = io(env, fakeApi().fetch);
    expect(await main(["register", "--handle", "taken"], r.io)).toBe(1);
    expect(r.err.join()).toMatch(/bad or taken handle/);
    expect(listAgents(env)).toHaveLength(0);
    expect(await main(["register", "--handle", "Bad Name"], r.io)).toBe(1);
  });

  it("add saves a key from the website after checking the agent exists", async () => {
    const env = home();
    expect(await main(["add", "atlas"], io(env, fakeApi().fetch).io)).toBe(0);
    expect(JSON.parse(readFileSync(join(env.AGENTS_MCP_HOME!, "atlas.json"), "utf8")).apiKey).toBe(KEY);
    expect(await main(["add", "ghost"], io(env, fakeApi().fetch).io)).toBe(1);
    expect(await main(["add", "moss"], io(env, fakeApi().fetch, "not-a-key").io)).toBe(1);
    expect(listAgents(env).map((a) => a.handle)).toEqual(["atlas"]);
  });

  it("prints setup for each client, with no key in it", () => {
    const all = snippets("atlas");
    for (const s of ["Claude Code", "Claude Desktop", "Cursor", "Codex"]) expect(all).toContain(s);
    expect(all).not.toContain("ak_");
    expect(JSON.parse(snippets("atlas", "cursor").split("\n").slice(1).join("\n"))).toEqual({ mcpServers: { "town-atlas": { command: "npx", args: ["-y", "agents-mcp", "serve", "--agent", "atlas"] } } });
  });
});

describe("server", () => {
  async function connect(opts: { host?: boolean; key?: boolean }) {
    const api = fakeApi();
    const server = createServer({ api: "http://town", handle: "atlas", apiKey: opts.key === false ? undefined : KEY, host: opts.host, fetch: api.fetch });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, api };
  }

  it("a trader gets the trading tools, a host doesn't", async () => {
    const trader = (await (await connect({})).client.listTools()).tools.map((t) => t.name);
    const host = (await (await connect({ host: true })).client.listTools()).tools.map((t) => t.name);
    for (const t of ["buy", "sell", "predict", "pledge", "launch"]) { expect(trader).toContain(t); expect(host).not.toContain(t); }
    for (const t of ["turn", "post", "my_agent", "bounties"]) expect(host).toContain(t);
  });

  it("launch sends a StonkFun launch as the agent", async () => {
    const { client, api } = await connect({});
    await client.callTool({ name: "launch", arguments: { name: "Lantern", symbol: "LNTRN", pitch: "Light for the night market." } });
    expect(api.calls.at(-1)).toMatchObject({ url: "http://town/v1/agents/atlas/actions", body: { actions: [{ type: "launch", name: "Lantern", symbol: "LNTRN", pitch: "Light for the night market." }] } });
  });

  it("turn sends one decision with the thought, signed with the agent's key", async () => {
    const { client, api } = await connect({});
    await client.callTool({ name: "turn", arguments: { thought: "quiet market", actions: [{ type: "post", body: "hi" }] } });
    expect(api.calls.at(-1)).toMatchObject({ url: "http://town/v1/agents/atlas/actions", auth: `Bearer ${KEY}`, body: { thought: "quiet market", actions: [{ type: "post", body: "hi" }] } });
  });

  it("a host's turn can't smuggle a trade", async () => {
    const { client, api } = await connect({ host: true });
    const r = await client.callTool({ name: "turn", arguments: { thought: "", actions: [{ type: "buy", token: "x", ethIn: "1", reason: "" }] } });
    expect(JSON.stringify(r.content)).toMatch(/never touches the market/);
    expect(api.calls.some((c) => c.url.endsWith("/actions"))).toBe(false);
  });

  it("without a key it still reads, and says how to connect an agent", async () => {
    const { client } = await connect({ key: false });
    const r = await client.callTool({ name: "post", arguments: { body: "hi" } });
    expect(JSON.stringify(r.content)).toMatch(/agents-mcp login/);
  });

  it("offers a take_turn prompt", async () => {
    const { client } = await connect({});
    const p = await client.getPrompt({ name: "take_turn" });
    expect(JSON.stringify(p.messages)).toMatch(/@atlas/);
  });
});
