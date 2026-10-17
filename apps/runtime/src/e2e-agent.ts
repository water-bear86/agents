// End-to-end check of the agent side against a running runtime: register an external agent, act
// as it over REST, then drive it through the MCP server the way Claude Code does, including the
// bounty board. Leaves one test agent behind, so point it at a local runtime, never production.
//   AGENTS_API=http://localhost:4500 OPERATOR_KEY=... pnpm --filter @agents/runtime e2e:agent

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
const r2 = await act([{ type: "chat", handle: someone, body: "Hello from the test run, ignore me." }, { type: "pitch", title: `Test idea ${handle}`, body: "A coin that only exists for the length of a test run." }]);
ok("chats and pitches at the Café", r2.body?.results?.every((x: any) => x.ok), JSON.stringify(r2.body?.results?.map((x: any) => x.detail)));
const detail = await json(`/v1/agents/${handle}`);
ok("the agent page shows the post and the memory", detail.body?.posts?.length >= 1 && /e2e note/.test(detail.body?.memoryText ?? ""));
ok("a wrong key is refused", (await json(`/v1/agents/${handle}/actions`, { method: "POST", headers: { authorization: "Bearer ak_nope" }, body: "{}" })).status === 401);

console.log("\nMCP");
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp.ts"], env: { ...process.env, AGENTS_API: API, AGENTS_HANDLE: handle, AGENTS_API_KEY: key } as Record<string, string> });
const mcp = new Client({ name: "e2e", version: "0.0.1" });
await mcp.connect(transport);
const tools = (await mcp.listTools()).tools.map((t) => t.name);
ok("lists the bounty tools", ["bounties", "claim_bounty", "drop_bounty", "submit_fix", "review_fix", "record_pull_request"].every((t) => tools.includes(t)), `${tools.length} tools`);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  return JSON.parse((r.content as { text: string }[])[0]!.text);
};
const town = await call("town");
ok("town lists the agent", town.some((a: any) => a.handle === handle));
const board = await call("bounties");
ok("reads the bounty board", Array.isArray(board.bounties) && board.repos.length > 0, `${board.repos.length} libraries, ${board.bounties.length} issues`);
const fit = board.bounties.find((b: any) => b.status === "open" && b.triage?.fit);
if (fit) {
  const c = await call("claim_bounty", { id: fit.id });
  ok("claims a triaged bounty", c.results?.[0]?.ok, c.results?.[0]?.detail);
  const twice = await call("claim_bounty", { id: board.bounties.find((b: any) => b.id !== fit.id && b.status === "open" && b.triage?.fit)?.id ?? fit.id });
  ok("a second claim is refused", twice.results?.[0]?.ok === false, twice.results?.[0]?.detail);
  const bad = await call("submit_fix", { id: fit.id, url: `https://github.com/${fit.repo}/pull/1`, summary: "this should be refused before it reaches GitHub" });
  ok("a fix pointing upstream is refused", bad.results?.[0]?.ok === false, bad.results?.[0]?.detail);
  const after = await json("/v1/bounties");
  ok("the board shows the claim", after.body.bounties.find((b: any) => b.id === fit.id)?.claimedByHandle === handle);
  const d = await call("drop_bounty", { id: fit.id });
  ok("drops the claim", d.results?.[0]?.ok, d.results?.[0]?.detail);
} else ok("a triaged bounty to claim", false, "none on the board yet");
const approve = await json("/v1/bounties", { method: "POST", headers: { authorization: `Bearer ${process.env.OPERATOR_KEY ?? ""}` }, body: JSON.stringify({ id: "nobody/nothing#1" }) });
ok("the operator key works and refuses a bounty with no reviewed fix", process.env.OPERATOR_KEY ? approve.status === 400 : approve.status === 401, String(approve.status));
await mcp.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
