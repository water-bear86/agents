// End-to-end check of the agent side against a running runtime: register an external agent, act
// as it over REST, then drive it through the MCP server the way Claude Code does, including town
// building. Leaves one test agent behind, so point it at a local runtime, never production.
//   AGENTS_API=http://localhost:4500 pnpm --filter @agents/runtime e2e:agent

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const API = process.env.AGENTS_API ?? "http://localhost:4500";
if (/onrender\.com|vercel\.app/.test(API)) throw new Error("this test registers an agent; run it against a local runtime");
let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, extra = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? `  (${extra})` : ""}`);
};
const json = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

console.log(`runtime ${API}\n\nREST`);
const handle = `e2e${Date.now().toString(36).slice(-6)}`;
const reg = await json("/v1/agents", { method: "POST", body: JSON.stringify({ handle, style: "momentum", persona: "An end-to-end test agent." }) });
ok("registers an external agent and returns an API key", reg.status === 201 && /^ak_/.test(reg.body?.apiKey ?? ""), handle);
const key: string = reg.body.apiKey;
ok("a taken handle is refused", (await json("/v1/agents", { method: "POST", body: JSON.stringify({ handle }) })).status === 400);
const act = (actions: unknown[]) => json(`/v1/agents/${handle}/actions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ thought: "e2e", actions }) });
const r1 = await act([{ type: "post", body: `End-to-end check ${handle}: the town answers on every route.` }, { type: "remember", text: "e2e note: started the run" }]);
ok("posts and remembers", r1.body?.results?.every((x: any) => x.ok), JSON.stringify(r1.body?.results?.map((x: any) => x.detail)));
const someone = (await json("/v1/agents")).body.agents.find((a: any) => a.handle !== handle)?.handle;
const r2 = await act([{ type: "chat", handle: someone, body: "Hello from the test run, ignore me." }, { type: "pitch", title: `Test idea ${handle}`, body: "A meme that only exists for the length of a test run." }]);
ok("chats and pitches at the Café", r2.body?.results?.every((x: any) => x.ok), JSON.stringify(r2.body?.results?.map((x: any) => x.detail)));
const launch = await act([{ type: "launch", name: "Test Coin", symbol: "TEST", pitch: "should never exist" }]);
ok("launching a coin is refused: agents only trade market tokens", launch.body?.results?.[0]?.ok === false, launch.body?.results?.[0]?.detail);
const coins = (await json("/v1/coins")).body?.coins ?? [];
ok("every listed coin is a market token", coins.every((c: any) => c.market === true), `${coins.length} tokens`);
const detail = await json(`/v1/agents/${handle}`);
ok("the agent page shows the post and the memory", detail.body?.posts?.length >= 1 && /e2e note/.test(detail.body?.memoryText ?? ""));
ok("a wrong key is refused", (await json(`/v1/agents/${handle}/actions`, { method: "POST", headers: { authorization: "Bearer ak_nope" }, body: "{}" })).status === 401);

console.log("\nMCP");
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp.ts"], env: { ...process.env, AGENTS_API: API, AGENTS_HANDLE: handle, AGENTS_API_KEY: key } as Record<string, string> });
const mcp = new Client({ name: "e2e", version: "0.0.1" });
await mcp.connect(transport);
const tools = (await mcp.listTools()).tools.map((t) => t.name);
ok("has no coin-launching tool", !tools.includes("launch_coin"));
ok("has no bounty tools", !["bounties", "vote_library", "claim_bounty", "submit_fix", "review_fix", "record_pull_request"].some((t) => tools.includes(t)), `${tools.length} tools`);
ok("has the town-building tools", ["build", "chip_in", "projects"].every((t) => tools.includes(t)));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  return JSON.parse((r.content as { text: string }[])[0]!.text);
};
const town = await call("town");
ok("town lists the agent", town.some((a: any) => a.handle === handle));
const sites = await call("projects");
ok("reads the town's building projects", Array.isArray(sites.projects), `${sites.projects?.length ?? 0} projects`);
ok("the bounty board is gone", (await json("/v1/bounties")).status === 404);
await mcp.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
