import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleMcpHttp } from "./http.js";
import { TownOAuth, allowedRedirect } from "./oauth.js";

// The whole sign-in, as claude.ai or Claude Desktop does it, driven by the SDK's own OAuth client:
// a 401 points at the metadata, the client registers itself, the owner pastes the agent's key on
// the sign-in page, the client trades the code (with PKCE) for tokens, and then plays a turn.

const KEY = `ak_${"ef".repeat(24)}`;
const ACCOUNT = "0xatlas";
let clock = Date.now();
let agents = new Map([[ACCOUNT, "atlas"]]);

/** The REST API the tools call: records what reached it. */
const calls: { url: string; auth?: string; body?: any }[] = [];
const api = (async (url: string, init?: RequestInit) => {
  calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.endsWith("/actions")) return Response.json({ results: [{ ok: true }] });
  return Response.json({ agents: [{ handle: "atlas", progress: { level: 2 } }] });
}) as unknown as typeof fetch;

let http: Server;
let base: string;
let oauth: TownOAuth;
let changes = 0;
const newOAuth = () => new TownOAuth({ issuer: base, accountForKey: (k) => (k === KEY ? ACCOUNT : null), handleOf: (a) => agents.get(a), now: () => clock, onChange: () => changes++ });

beforeAll(async () => {
  http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (oauth.handles(url.pathname)) return oauth.handle(req, res, url);
    let d = "";
    for await (const c of req) d += c;
    await handleMcpHttp(req, res, {
      api: "http://runtime",
      authenticate: (t) => (t === KEY ? { handle: "atlas" } : oauth.bearer(t)),
      resourceMetadata: oauth.resourceMetadataUrl,
      body: d ? JSON.parse(d) : undefined,
      fetch: api,
    });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => http.close(() => ok())));
beforeEach(() => {
  oauth = newOAuth();
  clock = Date.now();
  agents = new Map([[ACCOUNT, "atlas"]]);
});

const mcpUrl = () => new URL(`${base}/mcp`);
const textOf = (r: any) => JSON.parse(r.content[0].text);

/** An MCP client's OAuth state, kept in memory the way a desktop app would keep it on disk. */
class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  tok?: OAuthTokens;
  verifier = "";
  authUrl?: URL;
  constructor(readonly meta: Partial<OAuthClientMetadata> = {}) {}
  get redirectUrl() { return "http://localhost:6274/oauth/callback"; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Claude <test>", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...this.meta };
  }
  state() { return "st8"; }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i; }
  tokens() { return this.tok; }
  saveTokens(t: OAuthTokens) { this.tok = t; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The owner in a browser: open the sign-in page, then submit its form the way the page does. */
async function ownerSubmits(authUrl: URL, decision: "allow" | "read" | "deny", key?: string) {
  const pageRes = await fetch(authUrl);
  const html = await pageRes.text();
  expect(pageRes.status).toBe(200);
  expect(pageRes.headers.get("x-frame-options")).toBe("DENY");
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) form.set(m[1]!, unescape(m[2]!));
  form.set("decision", decision);
  if (key !== undefined) form.set("key", key);
  const res = await fetch(`${base}/oauth/authorize`, { method: "POST", body: form, redirect: "manual" });
  return { res, html, location: res.headers.get("location") ? new URL(res.headers.get("location")!) : undefined };
}

/** Connect with OAuth, sign in on the page, and come back connected. */
async function signIn(p: TestProvider, decision: "allow" | "read" = "allow", key: string | undefined = KEY) {
  const first = new StreamableHTTPClientTransport(mcpUrl(), { authProvider: p });
  await expect(new Client({ name: "t", version: "0" }).connect(first)).rejects.toThrow(UnauthorizedError);
  const { location } = await ownerSubmits(p.authUrl!, decision, key);
  expect(location!.origin + location!.pathname).toBe(p.redirectUrl);
  expect(location!.searchParams.get("state")).toBe("st8");
  expect(location!.searchParams.get("iss")).toBe(base);
  await first.finishAuth(location!.searchParams.get("code")!);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(mcpUrl(), { authProvider: p }));
  return c;
}

describe("hosted MCP sign-in (OAuth 2.1)", () => {
  it("publishes protected-resource and authorization-server metadata", async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as any;
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read", "act"] });
    expect(await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as any).toEqual(prm);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as any;
    expect(as).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  it("answers a request without a token with a 401 that points at the metadata", async () => {
    const r = await fetch(mcpUrl(), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer realm="agents-town", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await fetch(mcpUrl(), { method: "POST", headers: { authorization: "Bearer at_nope", "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/resource_metadata=".*", error="invalid_token"$/);
  });

  it("signs in with the agent's key through the SDK client, then plays a turn as the agent", async () => {
    const p = new TestProvider();
    const c = await signIn(p);
    expect(p.info?.client_id).toMatch(/^mcp_/);
    expect(p.tok).toMatchObject({ token_type: "Bearer", scope: "read act", expires_in: 3600 });
    expect(p.tok!.access_token).toMatch(/^at_/);
    expect(p.tok!.refresh_token).toMatch(/^rt_/);

    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["my_agent", "turn", "buy"]));
    const r = await c.callTool({ name: "turn", arguments: { thought: "quiet market, say hello", actions: [{ type: "post", body: "morning from the quarter" }] } });
    expect(textOf(r)).toEqual({ results: [{ ok: true }] });
    const sent = calls.at(-1)!;
    expect(sent.url).toBe("http://runtime/v1/agents/atlas/actions");
    // The REST API sees the client's own access token, never the owner's key.
    expect(sent.auth).toBe(`Bearer ${p.tok!.access_token}`);
    expect(sent.body).toEqual({ thought: "quiet market, say hello", actions: [{ type: "post", body: "morning from the quarter" }] });
    await c.close();
  });

  it("refreshes an expired access token and rotates the refresh token", async () => {
    const p = new TestProvider();
    const c = await signIn(p);
    const old = p.tok!;
    clock += 2 * 60 * 60_000; // the access token is an hour old
    expect(oauth.verify(old.access_token)).toBeNull();
    expect(textOf(await c.callTool({ name: "post", arguments: { body: "still here" } }))).toEqual({ results: [{ ok: true }] });
    expect(p.tok!.access_token).not.toBe(old.access_token);
    expect(p.tok!.refresh_token).not.toBe(old.refresh_token);
    expect(calls.at(-1)!.auth).toBe(`Bearer ${p.tok!.access_token}`);
    // The old refresh token stops working once the short grace period is over.
    clock += 2 * 60_000;
    const r = await fetch(`${base}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: old.refresh_token!, client_id: p.info!.client_id }) });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toBe("invalid_grant");
    await c.close();
  });

  it("signs in read-only without a key: the town is readable, acting is refused", async () => {
    const p = new TestProvider();
    const c = await signIn(p, "read", undefined);
    expect(p.tok!.scope).toBe("read");
    expect(textOf(await c.callTool({ name: "town", arguments: {} }))[0].handle).toBe("atlas");
    const before = calls.length;
    expect(textOf(await c.callTool({ name: "post", arguments: { body: "hello" } })).error).toMatch(/read-only/);
    expect(calls.slice(before).some((x) => x.url.endsWith("/actions"))).toBe(false);
    await c.close();
  });

  it("keeps the owner on the page when the key is wrong, and redirects nowhere", async () => {
    const p = new TestProvider();
    const t = new StreamableHTTPClientTransport(mcpUrl(), { authProvider: p });
    await expect(new Client({ name: "t", version: "0" }).connect(t)).rejects.toThrow(UnauthorizedError);
    const { res, html } = await ownerSubmits(p.authUrl!, "allow", "ak_wrong");
    expect(html).toContain("Claude &lt;test&gt;"); // the client's name is escaped
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toMatch(/doesn&#39;t belong to an agent/);
  });

  it("sends the owner back with access_denied on cancel", async () => {
    const p = new TestProvider();
    const t = new StreamableHTTPClientTransport(mcpUrl(), { authProvider: p });
    await expect(new Client({ name: "t", version: "0" }).connect(t)).rejects.toThrow(UnauthorizedError);
    const { location } = await ownerSubmits(p.authUrl!, "deny");
    expect(location!.searchParams.get("error")).toBe("access_denied");
    expect(location!.searchParams.get("code")).toBeNull();
  });

  it("keeps bearer API keys working as before", async () => {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(mcpUrl(), { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }));
    expect(textOf(await c.callTool({ name: "post", arguments: { body: "keyed" } }))).toEqual({ results: [{ ok: true }] });
    expect(calls.at(-1)!.auth).toBe(`Bearer ${KEY}`);
    await c.close();
  });

  it("stays signed in across a restart (snapshot saved with the world)", async () => {
    const p = new TestProvider();
    (await signIn(p)).close();
    expect(changes).toBeGreaterThan(0);
    const saved = JSON.parse(JSON.stringify(oauth.snapshot()));
    expect(JSON.stringify(saved)).not.toContain(p.tok!.access_token); // only hashes are saved
    oauth = newOAuth();
    expect(oauth.verify(p.tok!.access_token)).toBeNull();
    oauth.restore(saved);
    expect(oauth.verify(p.tok!.access_token)).toMatchObject({ account: ACCOUNT, scopes: ["read", "act"] });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(mcpUrl(), { authProvider: p }));
    expect(textOf(await c.callTool({ name: "post", arguments: { body: "after the restart" } }))).toEqual({ results: [{ ok: true }] });
    await c.close();
  });

  it("drops a sign-in once its agent is gone", async () => {
    const p = new TestProvider();
    (await signIn(p)).close();
    agents.delete(ACCOUNT);
    expect(oauth.verify(p.tok!.access_token)).toBeNull();
  });

  it("revokes a sign-in", async () => {
    const p = new TestProvider();
    (await signIn(p)).close();
    const r = await fetch(`${base}/oauth/revoke`, { method: "POST", body: new URLSearchParams({ token: p.tok!.refresh_token!, client_id: p.info!.client_id }) });
    expect(r.status).toBe(200);
    expect(oauth.verify(p.tok!.access_token)).toBeNull(); // the whole sign-in goes with its refresh token
  });
});

describe("authorization server checks", () => {
  const register = (body: unknown) => fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const pkce = (v: string) => createHash("sha256").update(v).digest("base64url");
  const VERIFIER = "v".repeat(50);

  /** Registers a client and gets a code for it, as the page would. */
  async function codeFor(extra: Record<string, unknown> = {}) {
    const reg = await (await register({ client_name: "x", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", ...extra })).json() as any;
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: pkce(VERIFIER), code_challenge_method: "S256", state: "s", resource: `${base}/mcp`, decision: "allow", key: KEY });
    const r = await fetch(`${base}/oauth/authorize`, { method: "POST", body: q, redirect: "manual" });
    return { reg, code: new URL(r.headers.get("location")!).searchParams.get("code")! };
  }
  const exchange = (body: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}/oauth/token`, { method: "POST", headers, body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: "https://claude.ai/api/mcp/auth_callback", ...body }) });

  it("only registers safe redirect URIs", async () => {
    expect((await register({ redirect_uris: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["client_credentials"] })).status).toBe(400);
    expect(allowedRedirect("http://127.0.0.1:33418/callback")).toBe(true);
    expect(allowedRedirect("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(allowedRedirect("https://claude.ai/cb#frag")).toBe(false);
  });

  it("shows an error page, never a redirect, for an unknown client or a redirect URI it didn't register", async () => {
    const reg = await (await register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" })).json() as any;
    const q = (o: Record<string, string>) => `${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", code_challenge: pkce(VERIFIER), code_challenge_method: "S256", ...o })}`;
    const unknown = await fetch(q({ client_id: "mcp_nope", redirect_uri: "https://claude.ai/api/mcp/auth_callback" }), { redirect: "manual" });
    expect(unknown.status).toBe(400);
    const elsewhere = await fetch(q({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get("location")).toBeNull();
    // With a good redirect URI, a missing PKCE challenge goes back to the client as an error.
    const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback" })}`, { redirect: "manual" });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("checks the PKCE verifier", async () => {
    const { reg, code } = await codeFor();
    const r = await exchange({ code, client_id: reg.client_id, code_verifier: "w".repeat(50) });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toBe("invalid_grant");
  });

  it("uses a code once, and a second use takes back the tokens the first got", async () => {
    const { reg, code } = await codeFor();
    const ok = await exchange({ code, client_id: reg.client_id, code_verifier: VERIFIER });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const tok = await ok.json() as any;
    expect(oauth.verify(tok.access_token)).not.toBeNull();
    const again = await exchange({ code, client_id: reg.client_id, code_verifier: VERIFIER });
    expect((await again.json() as any).error).toBe("invalid_grant");
    expect(oauth.verify(tok.access_token)).toBeNull();
  });

  it("makes a confidential client prove its secret", async () => {
    const { reg, code } = await codeFor({ token_endpoint_auth_method: "client_secret_basic" });
    expect(reg.client_secret).toMatch(/^cs_/);
    const without = await exchange({ code, client_id: reg.client_id, code_verifier: VERIFIER });
    expect(without.status).toBe(401);
    const basic = Buffer.from(`${reg.client_id}:${reg.client_secret}`).toString("base64");
    const { code: code2 } = await (async () => {
      const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: pkce(VERIFIER), code_challenge_method: "S256", decision: "allow", key: KEY });
      const r = await fetch(`${base}/oauth/authorize`, { method: "POST", body: q, redirect: "manual" });
      return { code: new URL(r.headers.get("location")!).searchParams.get("code")! };
    })();
    const ok = await exchange({ code: code2, code_verifier: VERIFIER }, { authorization: `Basic ${basic}` });
    expect(ok.status).toBe(200);
  });

  it("refuses a token for another resource", async () => {
    const { reg, code } = await codeFor();
    const r = await exchange({ code, client_id: reg.client_id, code_verifier: VERIFIER, resource: "https://elsewhere.example/mcp" });
    expect((await r.json() as any).error).toBe("invalid_target");
  });

  describe("refresh token reuse", () => {
    const refresh = (rt: string, clientId: string) => fetch(`${base}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }) });
    /** A fresh sign-in: the client and its first token pair. */
    async function signedIn() {
      const { reg, code } = await codeFor();
      const tok = (await (await exchange({ code, client_id: reg.client_id, code_verifier: VERIFIER })).json()) as any;
      return { clientId: reg.client_id as string, tok };
    }
    /** Whether a token pair still works: its access token is live and its refresh token can renew. */
    const alive = async (pair: any, clientId: string) => !!oauth.verify(pair.access_token) && (await refresh(pair.refresh_token, clientId)).status === 200;

    it("never lets a copied refresh token start a second chain (the Codex replay)", async () => {
      const { clientId, tok } = await signedIn();
      const copy = tok.refresh_token; // what a thief took
      const owner = (await (await refresh(tok.refresh_token, clientId)).json()) as any;
      const thief = (await (await refresh(copy, clientId)).json()) as any; // replayed inside the grace
      // No independent successor: the replay gets the very pair the owner got.
      expect(thief.refresh_token).toBe(owner.refresh_token);
      expect(thief.access_token).toBe(owner.access_token);
      clock += 2 * 60_000; // past the grace
      const late = await refresh(copy, clientId);
      expect(late.status).toBe(400);
      expect((await late.json()) as any).toMatchObject({ error: "invalid_grant" });
      // The reuse ended the whole sign-in: nothing either exchange produced still works.
      expect(oauth.verify(tok.access_token)).toBeNull();
      expect(await alive(owner, clientId)).toBe(false);
      expect(await alive(thief, clientId)).toBe(false);
    });

    it("keeps an owner signed in when they retry a refresh whose response was lost", async () => {
      const { clientId, tok } = await signedIn();
      const lost = (await (await refresh(tok.refresh_token, clientId)).json()) as any;
      clock += 30_000;
      const retry = (await (await refresh(tok.refresh_token, clientId)).json()) as any;
      expect(retry).toEqual(lost);
      clock += 60 * 60_000; // an hour on, the client renews as usual
      const next = await refresh(retry.refresh_token, clientId);
      expect(next.status).toBe(200);
      expect(oauth.verify(((await next.json()) as any).access_token)).not.toBeNull();
    });

    it("ends the sign-in when a rotated token comes back after a restart, even inside the grace", async () => {
      const { clientId, tok } = await signedIn();
      const owner = (await (await refresh(tok.refresh_token, clientId)).json()) as any;
      const saved = JSON.parse(JSON.stringify(oauth.snapshot()));
      oauth = newOAuth();
      oauth.restore(saved); // the retry pairs live only in memory; the rotation itself was saved
      expect((await refresh(tok.refresh_token, clientId)).status).toBe(400);
      expect(oauth.verify(owner.access_token)).toBeNull();
    });

    it("refuses an older ancestor without ending a healthy sign-in", async () => {
      const { clientId, tok } = await signedIn();
      const r1 = (await (await refresh(tok.refresh_token, clientId)).json()) as any;
      clock += 2 * 60_000;
      const r2 = (await (await refresh(r1.refresh_token, clientId)).json()) as any;
      clock += 2 * 60_000;
      // The first token was superseded twice over and is no longer kept: it gets nothing.
      expect((await refresh(tok.refresh_token, clientId)).status).toBe(400);
      expect(oauth.verify(r2.access_token)).not.toBeNull();
      // Reusing the latest rotated token is caught, and ends the sign-in.
      expect((await refresh(r1.refresh_token, clientId)).status).toBe(400);
      expect(oauth.verify(r2.access_token)).toBeNull();
    });
  });
});
