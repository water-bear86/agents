import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where an owner's agent keys live on their own computer: one file per agent, readable only
// by them. MCP client configs only ever name the handle, so a key never lands in a config
// file that gets synced, shared or pasted into a bug report.

/** The hosted runtime. Override with --api or AGENTS_API (e.g. http://localhost:4100 for a local demo). */
export const DEFAULT_API = "https://agents-paper-runtime.onrender.com";

export interface SavedAgent {
  handle: string;
  api: string;
  /** The agent's API key (`add`, `register`), or none when it signed in (`login`). */
  apiKey?: string;
  /** A sign-in from `stonkton-mcp login`: renews itself, so there's no key to keep. */
  oauth?: SavedSignIn;
  /** host: no trading tools (the town's host role). */
  host?: boolean;
  savedAt: number;
}

export interface SavedSignIn {
  clientId: string;
  refreshToken: string;
  accessToken?: string;
  /** Milliseconds since the epoch. */
  expiresAt?: number;
}

export const configDir = (env = process.env) =>
  env.AGENTS_MCP_HOME ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agents-mcp");

const HANDLE = /^[a-z0-9]{2,15}$/;
export const validHandle = (h: string) => HANDLE.test(h);

export function saveAgent(a: SavedAgent, env = process.env): string {
  if (!validHandle(a.handle)) throw new Error(`bad handle: ${a.handle}`);
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${a.handle}.json`);
  writeFileSync(file, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync keeps an existing file's mode
  return file;
}

export function loadAgent(handle: string, env = process.env): SavedAgent | null {
  if (!validHandle(handle)) return null;
  const file = join(configDir(env), `${handle}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SavedAgent) : null;
}

export function listAgents(env = process.env): SavedAgent[] {
  const dir = configDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadAgent(f.slice(0, -5), env))
    .filter((a): a is SavedAgent => !!a);
}

export interface Resolved {
  api: string;
  handle?: string;
  apiKey?: string;
  /** The saved agent, when it signed in with `login` (serve renews its token from it). */
  saved?: SavedAgent;
  host: boolean;
  /** Why no agent is connected, when none is. */
  problem?: string;
}

/**
 * Which agent to serve. Environment variables win (AGENTS_API, AGENTS_HANDLE, AGENTS_API_KEY,
 * AGENTS_ROLE=host, as before), then --agent <handle>, then the only saved agent.
 */
export function resolve(opts: { agent?: string; api?: string }, env = process.env): Resolved {
  const host = env.AGENTS_ROLE === "host";
  if (env.AGENTS_API_KEY && env.AGENTS_HANDLE) {
    return { api: opts.api ?? env.AGENTS_API ?? DEFAULT_API, handle: env.AGENTS_HANDLE, apiKey: env.AGENTS_API_KEY, host };
  }
  let saved: SavedAgent | null = null;
  let problem: string | undefined;
  const handle = opts.agent ?? env.AGENTS_HANDLE;
  if (handle) {
    saved = loadAgent(handle, env);
    if (!saved) problem = `@${handle} isn't saved on this computer: run \`stonkton-mcp login\` (or \`stonkton-mcp add ${handle}\` with its key)`;
  } else {
    const all = listAgents(env);
    if (all.length === 1) saved = all[0]!;
    else problem = all.length ? `several agents saved (${all.map((a) => a.handle).join(", ")}): pass --agent <handle>` : "no agent saved yet: run `stonkton-mcp login`";
  }
  return {
    api: opts.api ?? env.AGENTS_API ?? saved?.api ?? DEFAULT_API,
    handle: saved?.handle,
    apiKey: saved?.apiKey,
    saved: saved?.oauth ? saved : undefined,
    host: host || !!saved?.host,
    problem,
  };
}
