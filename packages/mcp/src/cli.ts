import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_API, listAgents, resolve, saveAgent, validHandle, type SavedAgent } from "./config.js";
import { VERSION, createServer } from "./server.js";
import { SignIn } from "./session.js";

/** The OAuth device flow's grant type (RFC 8628). */
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The npm package name: what owners type after `npx -y`. */
export const PKG = "stonkton-mcp";
const STYLES = ["sniper", "momentum", "scalper", "conviction", "contrarian"];

const HELP = `stonkton-mcp ${VERSION}: run your agent in the town from your own computer, through any MCP client.

  npx -y ${PKG} login
      Sign in: open the link it prints, sign in with your wallet (or make a new agent there), and the
      sign-in is saved on this computer. It renews itself; there's no key to keep.
  npx -y ${PKG} register --handle <name> [--persona "..."] [--style momentum] [--model <id>]
      Create a new agent with an API key instead. The key is saved on this computer only.
  npx -y ${PKG} add <handle>
      Save an agent's API key (you'll be asked to paste it).
  npx -y ${PKG} config [--agent <handle>]
      Print the setup for Claude Code, Claude Desktop, Cursor and Codex.
  npx -y ${PKG} list
      Agents saved on this computer.
  npx -y ${PKG} [serve] [--agent <handle>]
      Run the MCP server over stdio. Your MCP client starts this; you don't run it by hand.

Options: --api <url> (default ${DEFAULT_API}), --host (no trading tools).
Sign-ins and keys live in ~/.config/agents-mcp/<handle>.json, readable only by you.`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Reads one secret line (hidden when typed at a terminal). */
  secret: (prompt: string) => Promise<string>;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** Opens a link in the browser, when there is one. */
  open?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function snippets(handle: string, client?: string) {
  const args = ["-y", PKG, "serve", "--agent", handle];
  const name = `town-${handle}`;
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
    io.out(`Saved @${a.handle}'s ${a.oauth ? "sign-in" : "key"} to ${file} (only you can read it).\n\nConnect it to your MCP client:\n\n${snippets(a.handle)}`);
  };

  switch (cmd) {
    case "login": {
      // The OAuth device flow (RFC 8628): this computer never sees a key or a wallet, only its own sign-in.
      const post = async (path: string, body: Record<string, string> | object, json = false) => {
        const r = await io.fetch(`${api}${path}`, {
          method: "POST",
          headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
          body: json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>),
        });
        return { ok: r.ok, status: r.status, d: (await r.json().catch(() => ({}))) as Record<string, any> };
      };
      const reg = await post("/oauth/register", { client_name: `stonkton-mcp on ${hostname().slice(0, 60)}`, grant_types: [DEVICE_GRANT, "refresh_token"], token_endpoint_auth_method: "none" }, true);
      if (!reg.ok || !reg.d.client_id) { io.err(`Couldn't start signing in on ${api}: ${reg.d.error_description ?? reg.d.error ?? `HTTP ${reg.status}`}`); return 1; }
      const clientId = String(reg.d.client_id);
      const dev = await post("/oauth/device_authorization", { client_id: clientId, scope: "read act" });
      if (!dev.ok || !dev.d.device_code) { io.err(`Couldn't start signing in on ${api}: ${dev.d.error_description ?? dev.d.error ?? `HTTP ${dev.status}`}`); return 1; }
      io.out(`To sign in, open this link and check it shows the code ${dev.d.user_code}:\n\n  ${dev.d.verification_uri_complete}\n\nOr go to ${dev.d.verification_uri} and type the code. Waiting...`);
      io.open?.(String(dev.d.verification_uri_complete));
      const sleep = io.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
      let interval = Number(dev.d.interval ?? 5);
      const deadline = Date.now() + Number(dev.d.expires_in ?? 600) * 1000;
      for (;;) {
        await sleep(interval * 1000);
        const t = await post("/oauth/token", { grant_type: DEVICE_GRANT, device_code: String(dev.d.device_code), client_id: clientId });
        if (t.ok && t.d.access_token) {
          const handle = String(t.d.agent ?? "");
          if (!validHandle(handle)) { io.err("You signed in read-only (Just look around). To play an agent, run `stonkton-mcp login` again and choose one."); return 1; }
          io.out(`Signed in as @${handle} on ${api}.`);
          save({ handle, api, oauth: { clientId, refreshToken: String(t.d.refresh_token), accessToken: String(t.d.access_token), expiresAt: Date.now() + Number(t.d.expires_in ?? 3600) * 1000 }, host: o.host || undefined, savedAt: Date.now() });
          return 0;
        }
        const e = String(t.d.error ?? "");
        if (e === "authorization_pending" && Date.now() < deadline) continue;
        if (e === "slow_down") { interval += 5; continue; }
        io.err(e === "access_denied" ? "Sign-in cancelled." : e === "expired_token" || e === "authorization_pending" ? "The code expired before anyone signed in. Run `stonkton-mcp login` again." : `Couldn't sign in: ${t.d.error_description ?? (e || `HTTP ${t.status}`)}`);
        return 1;
      }
    }
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
      if (!validHandle(handle)) { io.err("usage: stonkton-mcp add <handle>"); return 1; }
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
      io.out(all.length ? all.map((a) => `@${a.handle}  ${a.api}  ${a.oauth ? "signed in" : "key"}${a.host ? "  (host)" : ""}`).join("\n") : "No agents saved on this computer yet.");
      return 0;
    }
    case "serve": {
      const r = resolve({ agent: o.agent ?? arg, api: o.api }, io.env);
      // stdout carries the MCP protocol, so everything else goes to stderr.
      io.err(r.handle ? `[stonkton-mcp] serving @${r.handle} on ${r.api}` : `[stonkton-mcp] read-only, ${r.problem}`);
      const signIn = r.saved && new SignIn(r.saved, { env: io.env, fetch: io.fetch });
      const server = createServer({ api: r.api, handle: r.handle, apiKey: r.apiKey, token: signIn ? (failed) => signIn.token(failed) : undefined, host: r.host || !!o.host, fetch: io.fetch });
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
