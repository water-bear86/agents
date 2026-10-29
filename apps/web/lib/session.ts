"use client";
import { useEffect, useState } from "react";
import { brand } from "@agents/brand";
import { API } from "./api";

// Signing in to manage your agents. The website is one more OAuth client of the runtime, like any MCP
// connector: it sends you to the town's own sign-in page (wallet, claim with a key, or a key alone),
// and gets back a token that acts as the one agent you chose. Each agent you sign in as is kept here,
// in this browser only, so you can sign in again to add another. The runtime never sees a password and
// the website never sees your key or your wallet's signature.

const CLIENT_KEY = "town.web.client.v1";
const SESSIONS_KEY = "town.web.sessions.v1";
const PENDING_KEY = "town.web.pending.v1";
const CHANGED = "town-sessions-changed";
/** Refresh this long before the access token runs out. */
const EARLY_MS = 60_000;

/** One agent you're signed in as. */
export interface Session {
  handle: string;
  access: string;
  refresh: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  scope: string;
  since: number;
}

interface StoredClient { id: string; api: string; redirect: string }
interface Pending { state: string; verifier: string; clientId: string; back: string; at: number }
interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; scope: string; agent?: string }

/** You aren't (or are no longer) signed in as that agent. */
export class SignedOut extends Error {}

function read<T>(storage: () => Storage, key: string): T | null {
  try { const v = storage().getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}
function write(storage: () => Storage, key: string, value: unknown) {
  try { if (value === null) storage().removeItem(key); else storage().setItem(key, JSON.stringify(value)); } catch { /* private window: works until the tab closes */ }
}
const local = () => window.localStorage;
const tab = () => window.sessionStorage;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const issuer = API.replace(/\/+$/, "");
const redirectUri = () => `${window.location.origin}/signin/callback`;

/** Only paths on this site, so a sign-in link can't send you somewhere else afterwards. */
export const safeBack = (back: string | null | undefined) => (back && back.startsWith("/") && !back.startsWith("//") ? back : "/me");

async function oauthError(r: Response): Promise<{ code: string; message: string }> {
  const b = (await r.json().catch(() => ({}))) as { error?: string; error_description?: string };
  return { code: b.error ?? `http_${r.status}`, message: b.error_description ?? `The town answered ${r.status}.` };
}

/** This website's client id at the runtime, registering it the first time. */
async function clientId(): Promise<string> {
  const saved = read<StoredClient>(local, CLIENT_KEY);
  if (saved && saved.api === issuer && saved.redirect === redirectUri()) return saved.id;
  const origin = window.location.origin;
  const r = await fetch(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `${brand.name} website`,
      ...(origin.startsWith("https://") ? { client_uri: origin } : {}),
      redirect_uris: [redirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read act",
    }),
  });
  if (!r.ok) throw new Error(`Couldn't reach the town's sign-in: ${(await oauthError(r)).message}`);
  const c = (await r.json()) as { client_id: string };
  write(local, CLIENT_KEY, { id: c.client_id, api: issuer, redirect: redirectUri() } satisfies StoredClient);
  return c.client_id;
}

/** Sends you to the town's sign-in page; you come back to `back` once you've chosen an agent. */
export async function startSignIn(back = "/me") {
  const id = await clientId();
  const verifier = random(32);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = random(16);
  write(tab, PENDING_KEY, { state, verifier, clientId: id, back: safeBack(back), at: Date.now() } satisfies Pending);
  const u = new URL(`${issuer}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: id, redirect_uri: redirectUri(), state, scope: "read act",
    code_challenge: challenge, code_challenge_method: "S256", resource: `${issuer}/mcp`,
  })) u.searchParams.set(k, v);
  window.location.assign(u.href);
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const r = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (r.ok) return (await r.json()) as TokenResponse;
  const e = await oauthError(r);
  // The runtime forgot this website (its client list was trimmed): register again next time.
  if (e.code === "invalid_client") write(local, CLIENT_KEY, null);
  const err = new Error(e.message) as Error & { code?: string };
  err.code = e.code;
  throw err;
}

/** A code works once; React may run the callback twice in development, so each code is redeemed once. */
const redeeming = new Map<string, Promise<{ handle: string; back: string }>>();

/** Finishes a sign-in from the callback URL's query: stores the agent's tokens and says where to go next. */
export function finishSignIn(q: URLSearchParams): Promise<{ handle: string; back: string }> {
  const code = q.get("code") ?? "";
  const running = redeeming.get(code);
  if (running) return running;
  const p = redeem(q);
  redeeming.set(code, p);
  return p;
}

async function redeem(q: URLSearchParams): Promise<{ handle: string; back: string }> {
  const pending = read<Pending>(tab, PENDING_KEY);
  const error = q.get("error");
  if (error) {
    write(tab, PENDING_KEY, null);
    throw new Error(error === "access_denied" ? "You cancelled the sign-in." : q.get("error_description") ?? "The sign-in didn't finish.");
  }
  if (!pending || pending.state !== q.get("state")) throw new Error("This sign-in link doesn't match one started in this tab. Start again from My agents.");
  const iss = q.get("iss");
  if (iss && iss.replace(/\/+$/, "") !== issuer) throw new Error("That sign-in came back from a different server, so it was ignored.");
  write(tab, PENDING_KEY, null);
  const t = await tokenRequest({
    grant_type: "authorization_code", code: q.get("code") ?? "", redirect_uri: redirectUri(),
    client_id: pending.clientId, code_verifier: pending.verifier,
  });
  if (!t.agent || !t.scope.split(" ").includes("act")) {
    void revoke(t.refresh_token, pending.clientId);
    throw new Error("You chose to just look around, so there's no agent to manage. Sign in again and pick an agent, or paste its key.");
  }
  const sessions = allSessions();
  const old = sessions[t.agent];
  if (old) void revoke(old.refresh, pending.clientId);
  sessions[t.agent] = { handle: t.agent, access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, scope: t.scope, since: Date.now() };
  save(sessions);
  return { handle: t.agent, back: pending.back };
}

function allSessions(): Record<string, Session> {
  return read<Record<string, Session>>(local, SESSIONS_KEY) ?? {};
}
function save(sessions: Record<string, Session>) {
  write(local, SESSIONS_KEY, Object.keys(sessions).length ? sessions : null);
  window.dispatchEvent(new Event(CHANGED));
}
function drop(handle: string) {
  const s = allSessions();
  delete s[handle];
  save(s);
}

async function revoke(token: string, id?: string) {
  const client = id ?? read<StoredClient>(local, CLIENT_KEY)?.id;
  if (!client) return;
  await fetch(`${issuer}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: client }).toString(),
  }).catch(() => {});
}

/** Refreshes in flight, per agent, so two calls at once share one refresh. */
const refreshing = new Map<string, Promise<string>>();

/** A live access token for the agent, refreshing it first when it's about to run out. */
export async function accessToken(handle: string, force = false): Promise<string> {
  const s = allSessions()[handle];
  if (!s) throw new SignedOut(`You're not signed in as @${handle}.`);
  if (!force && s.expiresAt - EARLY_MS > Date.now()) return s.access;
  const running = refreshing.get(handle);
  if (running) return running;
  const p = (async () => {
    const id = read<StoredClient>(local, CLIENT_KEY)?.id;
    if (!id) { drop(handle); throw new SignedOut(`Your sign-in for @${handle} ended. Sign in again.`); }
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: s.refresh, client_id: id });
      const now = allSessions();
      now[handle] = { ...s, access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, scope: t.scope };
      save(now);
      return t.access_token;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "invalid_grant" || code === "invalid_client") { drop(handle); throw new SignedOut(`Your sign-in for @${handle} ended. Sign in again.`); }
      throw e;
    }
  })().finally(() => refreshing.delete(handle));
  refreshing.set(handle, p);
  return p;
}

export interface ActionResult { ok: boolean; detail?: string }

/** Has the agent take actions now, as its owner. */
export async function act(handle: string, actions: Record<string, unknown>[], thought: string): Promise<ActionResult[]> {
  const send = async (token: string) => fetch(`${issuer}/v1/agents/${encodeURIComponent(handle)}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ thought, actions }),
  });
  let r = await send(await accessToken(handle));
  // Revoked elsewhere or clock skew: one forced refresh, then give up.
  if (r.status === 401) r = await send(await accessToken(handle, true));
  if (r.status === 401) { drop(handle); throw new SignedOut(`Your sign-in for @${handle} ended. Sign in again.`); }
  const b = (await r.json().catch(() => ({}))) as { results?: ActionResult[]; error?: string };
  if (!r.ok) throw new Error(b.error ?? `The town answered ${r.status}.`);
  return b.results ?? [];
}

/** Signs out of one agent here and ends that sign-in at the town. */
export async function signOut(handle: string) {
  const s = allSessions()[handle];
  drop(handle);
  if (s) await revoke(s.refresh);
}

/** The agents you're signed in as in this browser, kept current across tabs. Null until read. */
export function useSessions(): Session[] | null {
  const [list, setList] = useState<Session[] | null>(null);
  useEffect(() => {
    const load = () => setList(Object.values(allSessions()).sort((a, b) => a.since - b.since));
    load();
    const onStorage = (e: StorageEvent) => { if (e.key === SESSIONS_KEY || e.key === null) load(); };
    window.addEventListener(CHANGED, load);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(CHANGED, load); window.removeEventListener("storage", onStorage); };
  }, []);
  return list;
}
