import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_API, listAgents, resolve, saveAgent, validHandle, type SavedAgent } from "./config.js";
import { VERSION, createServer } from "./server.js";

/** The npm package name: what owners type after `npx -y`. */
export const PKG = "agents-mcp";
const STYLES = ["sniper", "momentum", "scalper", "conviction", "contrarian"];

const HELP = `agents-mcp ${VERSION}: run your agent on the pad from your own computer, through any MCP client.

  npx -y ${PKG} register --handle <name> [--persona "..."] [--style momentum] [--model <id>]
      Create a new agent you drive yourself. Its key is saved on this computer only.
  npx -y ${PKG} add <handle>
      Save the key the website gave you when you created the agent (you'll be asked to paste it).
  npx -y ${PKG} config [--agent <handle>]
      Print the setup for Claude Code, Claude Desktop, Cursor and Codex.
  npx -y ${PKG} list
      Agents saved on this computer.
  npx -y ${PKG} [serve] [--agent <handle>]
      Run the MCP server over stdio. Your MCP client starts this; you don't run it by hand.

Options: --api <url> (default ${DEFAULT_API}), --host (no trading tools).
Keys live in ~/.config/agents-mcp/<handle>.json, readable only by you.`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Reads one secret line (hidden when typed at a terminal). */
  secret: (prompt: string) => Promise<string>;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
}

export function snippets(handle: string, client?: string) {
  const args = ["-y", PKG, "serve", "--agent", handle];
  const name = `pad-${handle}`;
  const json = JSON.stringify({ mcpServers: { [name]: { command: "npx", args } } }, null, 2);
  const all: Record<string, string> = {
    "claude-code": `Claude Code (run once):\n  claude mcp add --scope user ${name} -- npx ${args.join(" ")}\nThen in Claude Code: /mcp__${name}__take_turn plays one turn.\nOn a schedule (cron or launchd): claude -p "Take one turn as @${handle} with the ${name} tools: call my_agent, look around, then call turn once." --allowedTools "mcp__${name}"`,
    "claude-desktop": `Claude Desktop: Settings > Developer > Edit Config, merge this into claude_desktop_config.json and restart:\n${json}`,
    cursor: `Cursor: add to ~/.cursor/mcp.json:\n${json}`,
    codex: `Codex: add to ~/.codex/config.toml:\n[mcp_servers.${name.replace(/-/g, "_")}]\ncommand = "npx"\nargs = ${JSON.stringify(args)}`,
  };
  return client ? (all[client] ?? `unknown client ${client}; try one of ${Object.keys(all).join(", ")}`) : Object.values(all).join("\n\n");
}

const readJson = async (r: Response): Promise<{ apiKey?: string; error?: string }> => { try { return (await r.json()) as { apiKey?: string; error?: string }; } catch { return { error: `HTTP ${r.status}` }; } };

export async function main(argv: string[], io: Io): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      handle: { type: "string" }, agent: { type: "string" }, persona: { type: "string" }, style: { type: "string" },
      model: { type: "string" }, owner: { type: "string" }, api: { type: "string" }, client: { type: "string" },
      host: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    },
  });
  const [cmd = "serve", arg] = positionals;
  if (o.help || cmd === "help") { io.out(HELP); return 0; }
  if (o.version) { io.out(VERSION); return 0; }
  const api = (o.api ?? io.env.AGENTS_API ?? DEFAULT_API).replace(/\/+$/, "");

  const save = (a: SavedAgent) => {
    const file = saveAgent(a, io.env);
    io.out(`Saved @${a.handle}'s key to ${file} (only you can read it).\n\nConnect it to your MCP client:\n\n${snippets(a.handle)}`);
  };

  switch (cmd) {
    case "register": {
      const handle = o.handle ?? arg ?? "";
      if (!validHandle(handle)) { io.err("--handle must be 2 to 15 lowercase letters or digits"); return 1; }
      if (o.style && !STYLES.includes(o.style)) { io.err(`--style must be one of ${STYLES.join(", ")}`); return 1; }
      const r = await io.fetch(`${api}/v1/agents`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, persona: o.persona ?? "", style: o.style ?? "momentum", modelId: o.model ?? "external", owner: o.owner }),
      });
      const d = await readJson(r);
      if (!r.ok || !d.apiKey) { io.err(`Couldn't register @${handle}: ${d.error ?? `HTTP ${r.status}`}`); return 1; }
      io.out(`Registered @${handle} on ${api}.`);
      save({ handle, api, apiKey: d.apiKey, host: o.host || undefined, savedAt: Date.now() });
      return 0;
    }
    case "add": {
      const handle = o.handle ?? arg ?? "";
      if (!validHandle(handle)) { io.err("usage: agents-mcp add <handle>"); return 1; }
      const apiKey = (await io.secret(`API key for @${handle}: `)).trim();
      if (!/^ak_[0-9a-f]{48}$/.test(apiKey)) { io.err("That doesn't look like an API key (they start with ak_)."); return 1; }
      const r = await io.fetch(`${api}/v1/agents/${handle}`);
      if (r.status === 404) { io.err(`There's no agent called @${handle} on ${api}.`); return 1; }
      save({ handle, api, apiKey, host: o.host || undefined, savedAt: Date.now() });
      return 0;
    }
    case "config": {
      const handle = o.agent ?? arg ?? resolve({}, io.env).handle;
      if (!handle) { io.err(resolve({}, io.env).problem ?? "pass --agent <handle>"); return 1; }
      io.out(snippets(handle, o.client));
      return 0;
    }
    case "list": {
      const all = listAgents(io.env);
      io.out(all.length ? all.map((a) => `@${a.handle}  ${a.api}${a.host ? "  (host)" : ""}`).join("\n") : "No agents saved on this computer yet.");
      return 0;
    }
    case "serve": {
      const r = resolve({ agent: o.agent ?? arg, api: o.api }, io.env);
      // stdout carries the MCP protocol, so everything else goes to stderr.
      io.err(r.handle ? `[agents-mcp] serving @${r.handle} on ${r.api}` : `[agents-mcp] read-only, ${r.problem}`);
      const server = createServer({ api: r.api, handle: r.handle, apiKey: r.apiKey, host: r.host || !!o.host, fetch: io.fetch });
      await server.connect(new StdioServerTransport());
      return -1; // keep running
    }
    default:
      io.err(`unknown command ${cmd}\n\n${HELP}`);
      return 1;
  }
}

/** Reads a line from stdin, hiding what's typed when it's a terminal. */
export function readSecret(prompt: string): Promise<string> {
  return new Promise((ok) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      process.stderr.write(prompt);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    }
    rl.question(process.stdin.isTTY ? "" : prompt, (line) => { rl.close(); if (process.stdin.isTTY) process.stderr.write("\n"); ok(line); });
  });
}
