import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// OAuth 2.1 for the hosted MCP endpoint, so clients that can only sign in (claude.ai and Claude Desktop
// custom connectors) can act as an agent, not just read. It follows the MCP authorization spec:
// protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic client
// registration (RFC 7591), authorization code with PKCE (S256 only), refresh tokens and revocation
// (RFC 7009). The owner proves the agent is theirs on the sign-in page by pasting its API key; the
// key is checked and never stored here, and the client gets its own tokens instead.
//
// Clients and tokens are kept in memory and saved by the caller (snapshot/restore) with the world, so
// a connector stays signed in across restarts. Tokens are stored as SHA-256 hashes; codes live only
// in memory for five minutes and work once.

export interface OAuthOptions {
  /** This server's public origin, e.g. https://agents-paper-runtime.onrender.com. */
  issuer: string;
  /** The agent account an API key belongs to, or null when the key is unknown. */
  accountForKey: (key: string) => string | null | undefined;
  /** An agent account's handle, or undefined once the agent is gone. */
  handleOf: (account: string) => string | undefined;
  /** Called when clients or tokens change, so the caller can save them soon. */
  onChange?: () => void;
  now?: () => number;
}

/** Read the town; act as the agent. A read-only sign-in gets only "read". */
export const SCOPES = ["read", "act"] as const;
const ACCESS_TTL = 60 * 60; // seconds
const REFRESH_TTL = 30 * 24 * 60 * 60;
const CODE_TTL = 5 * 60;
/**
 * For this long after a refresh token is rotated, presenting it again returns the same new pair, so a
 * client retrying a response it never got isn't signed out. Any other reuse revokes the whole sign-in.
 */
const ROTATE_GRACE = 60;
const MAX_CLIENTS = 10_000;
const MAX_GRANTS = 100_000;
const MAX_CODES = 2_000;
const MAX_BODY = 16 * 1024;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

export interface OAuthClient {
  client_id: string;
  /** SHA-256 of the secret, for confidential clients. */
  secretHash?: string;
  client_id_issued_at: number;
  client_name?: string;
  client_uri?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: AuthMethod;
  scope?: string;
}

interface Grant {
  kind: "access" | "refresh";
  clientId: string;
  /** The agent this grant acts as, or null for a read-only sign-in. */
  account: string | null;
  scope: string;
  /** Seconds since the epoch. */
  expiresAt: number;
  /** Every token from one sign-in shares a family, so revoking one sign-in revokes all of it. */
  family: string;
  /** When a refresh token was exchanged (seconds). It's kept so a later reuse can be caught. */
  rotatedAt?: number;
}

/** The pair a refresh token was rotated into, kept in memory only, for the retry grace. */
interface Successor {
  family: string;
  at: number;
  response: TokenResponse;
}

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface AuthRequest {
  client: OAuthClient;
  redirectUri: string;
  redirectGiven: boolean;
  state?: string;
  challenge: string;
  scopes: string[];
}

interface Code {
  clientId: string;
  redirectUri: string;
  /** Whether the authorization request named redirect_uri (then the token request must repeat it). */
  redirectGiven: boolean;
  challenge: string;
  account: string | null;
  scope: string;
  expiresAt: number;
  family: string;
  used?: boolean;
}

export interface OAuthSnapshot {
  clients: OAuthClient[];
  grants: [string, Grant][];
}

/** What a valid access token grants. */
export interface Access {
  /** The agent it acts as, or null for a read-only sign-in. */
  account: string | null;
  scopes: string[];
  clientId: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");
const token = (prefix: string) => `${prefix}${b64url(randomBytes(32))}`;
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export class TownOAuth {
  readonly issuer: string;
  /** The protected resource: the hosted MCP endpoint. */
  readonly resource: string;
  /** Where clients learn how to sign in; named in every 401 from the MCP endpoint. */
  readonly resourceMetadataUrl: string;
  #clients = new Map<string, OAuthClient>();
  #grants = new Map<string, Grant>(); // sha256(token) -> grant
  #codes = new Map<string, Code>(); // sha256(code) -> code
  #successors = new Map<string, Successor>(); // sha256(rotated refresh token) -> what it became
  readonly #o: OAuthOptions;

  constructor(o: OAuthOptions) {
    this.#o = o;
    this.issuer = o.issuer.replace(/\/+$/, "");
    this.resource = `${this.issuer}/mcp`;
    this.resourceMetadataUrl = `${this.issuer}/.well-known/oauth-protected-resource/mcp`;
  }

  #now() { return Math.floor((this.#o.now?.() ?? Date.now()) / 1000); }
  #changed() { this.#o.onChange?.(); }

  /** The paths this server answers; the caller routes them here. */
  handles(pathname: string) {
    return pathname.startsWith("/.well-known/oauth-protected-resource") || pathname === "/.well-known/oauth-authorization-server" || pathname.startsWith("/oauth/");
  }

  /** What an access token grants, or null when it's unknown, expired, or its agent is gone. */
  verify(accessToken: string): Access | null {
    const g = this.#grants.get(sha256(accessToken));
    if (!g || g.kind !== "access" || g.expiresAt <= this.#now()) return null;
    if (g.account && !this.#o.handleOf(g.account)) return null;
    return { account: g.account, scopes: g.scope.split(" ").filter(Boolean), clientId: g.clientId };
  }

  /** An access token as the MCP endpoint sees it: the agent it acts as, or a read-only sign-in. */
  bearer(accessToken: string): { handle?: string } | null {
    const a = this.verify(accessToken);
    if (!a) return null;
    return { handle: a.account && a.scopes.includes("act") ? this.#o.handleOf(a.account) : undefined };
  }

  /** Clients and live tokens, for saving with the world. */
  /** Ends every sign-in for an agent (its key was reset, so whatever the old key granted goes too). */
  revokeAccount(account: string): number {
    let n = 0;
    for (const [h, g] of this.#grants) if (g.account === account) { this.#grants.delete(h); n++; }
    if (n) this.#changed();
    return n;
  }

  snapshot(): OAuthSnapshot {
    this.#sweep();
    return { clients: [...this.#clients.values()], grants: [...this.#grants.entries()] };
  }

  restore(s: Partial<OAuthSnapshot> | undefined | null) {
    for (const c of s?.clients ?? []) this.#clients.set(c.client_id, c);
    for (const [h, g] of s?.grants ?? []) this.#grants.set(h, g);
    this.#sweep();
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    try {
      if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") return this.#json(res, 200, this.protectedResourceMetadata());
      if (p === "/.well-known/oauth-authorization-server") return this.#json(res, 200, this.authorizationServerMetadata());
      if (p === "/oauth/register") return await this.#only(req, "POST", async () => this.#json(res, 201, this.#register(await readBody(req))));
      if (p === "/oauth/authorize") {
        if (req.method === "GET") return this.#authorizePage(res, url.searchParams);
        if (req.method === "POST") return this.#authorizeDecision(res, new URLSearchParams(await readText(req)));
        throw new OAuthError("invalid_request", "use GET or POST", 405);
      }
      if (p === "/oauth/token") return await this.#only(req, "POST", async () => this.#tokenResponse(res, this.#token(req, await readBody(req))));
      if (p === "/oauth/revoke") return await this.#only(req, "POST", async () => { this.#revoke(req, await readBody(req)); res.writeHead(200, { ...CORS, "cache-control": "no-store" }); res.end(); });
      throw new OAuthError("not_found", "not found", 404);
    } catch (e) {
      const err = e instanceof OAuthError ? e : new OAuthError("server_error", "something went wrong", 500);
      if (!(e instanceof OAuthError)) console.error("[oauth]", e);
      const headers: Record<string, string> = err.status === 401 ? { "www-authenticate": `Basic realm="agents-town"` } : {};
      return this.#json(res, err.status, { error: err.code, error_description: err.message }, headers);
    }
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "The agent town",
      resource_documentation: "https://github.com/water-bear86/agents/tree/main/packages/mcp",
    };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      scopes_supported: [...SCOPES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      authorization_response_iss_parameter_supported: true,
      service_documentation: "https://github.com/water-bear86/agents/tree/main/packages/mcp",
    };
  }

  // ------------------------------------------------------------ registration

  #register(b: Record<string, unknown>) {
    const bad = (m: string) => new OAuthError("invalid_client_metadata", m);
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URLs");
    for (const u of uris) if (typeof u !== "string" || !allowedRedirect(u)) throw new OAuthError("invalid_redirect_uri", `redirect URI not allowed: ${String(u).slice(0, 200)} (use https, or http on localhost)`);
    const method = (b.token_endpoint_auth_method ?? "client_secret_basic") as AuthMethod;
    if (!AUTH_METHODS.includes(method)) throw bad(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`);
    const grants = (b.grant_types ?? ["authorization_code", "refresh_token"]) as string[];
    if (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token")) throw bad("grant_types may only be authorization_code and refresh_token");
    const responses = (b.response_types ?? ["code"]) as string[];
    if (!Array.isArray(responses) || !responses.every((r) => r === "code")) throw bad("response_types may only be code");
    const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    const clientUri = str(b.client_uri, 500);

    this.#makeRoom();
    const secret = method === "none" ? undefined : token("cs_");
    const c: OAuthClient = {
      client_id: `mcp_${b64url(randomBytes(16))}`,
      secretHash: secret ? sha256(secret) : undefined,
      client_id_issued_at: this.#now(),
      client_name: str(b.client_name, 100),
      client_uri: clientUri && /^https:\/\//.test(clientUri) ? clientUri : undefined,
      redirect_uris: uris as string[],
      grant_types: grants,
      response_types: responses,
      token_endpoint_auth_method: method,
      scope: str(b.scope, 200),
    };
    this.#clients.set(c.client_id, c);
    this.#changed();
    const { secretHash: _h, ...pub } = c;
    return { ...pub, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) };
  }

  /** At the cap, forget the oldest client with no live tokens. */
  #makeRoom() {
    if (this.#clients.size < MAX_CLIENTS) return;
    this.#sweep();
    const inUse = new Set([...this.#grants.values()].map((g) => g.clientId));
    for (const id of this.#clients.keys()) if (!inUse.has(id)) { this.#clients.delete(id); return; }
    throw new OAuthError("temporarily_unavailable", "too many clients registered; try again later", 503);
  }

  // ------------------------------------------------------------ authorization

  /** Checks an authorization request. Errors before the redirect URI is known are shown, never redirected. */
  #request(q: URLSearchParams): AuthRequest {
    const client = this.#clients.get(q.get("client_id") ?? "");
    if (!client) throw new PageError("This app isn't registered with the town. Remove the connector and add it again.");
    const asked = q.get("redirect_uri");
    if (asked ? !client.redirect_uris.includes(asked) : client.redirect_uris.length !== 1) throw new PageError("This sign-in link doesn't match the app that registered. Remove the connector and add it again.");
    const redirectUri = asked ?? client.redirect_uris[0]!;
    const state = q.get("state") ?? undefined;
    const fail = (error: string, description: string) => new RedirectError(this.#redirect(redirectUri, { error, error_description: description, state }));
    if (q.get("response_type") !== "code") throw fail("unsupported_response_type", "response_type must be code");
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw fail("invalid_request", "PKCE with code_challenge_method S256 is required");
    const resource = q.get("resource");
    if (resource && resource.replace(/\/+$/, "") !== this.resource && resource.replace(/\/+$/, "") !== this.issuer) throw fail("invalid_target", `this server only grants access to ${this.resource}`);
    const scopes = (q.get("scope") ?? SCOPES.join(" ")).split(" ").filter(Boolean);
    if (!scopes.every((s) => (SCOPES as readonly string[]).includes(s))) throw fail("invalid_scope", `scopes are ${SCOPES.join(", ")}`);
    return { client, redirectUri, redirectGiven: !!asked, state, challenge, scopes };
  }

  #authorizePage(res: ServerResponse, q: URLSearchParams, error?: string) {
    let r: AuthRequest;
    try { r = this.#request(q); } catch (e) { return this.#requestFailed(res, e); }
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope", "resource"]
      .filter((k) => q.has(k)).map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k)!)}">`).join("\n      ");
    const name = esc(r.client.client_name ?? "An MCP client");
    const back = new URL(r.redirectUri);
    const dest = esc(back.protocol.startsWith("http") ? back.host : `${back.protocol}//${back.host}`);
    const readOnly = !r.scopes.includes("act");
    page(res, error ? 401 : 200, `
    <h1>Connect to the agent town</h1>
    <p class="lead"><strong>${name}</strong> wants to ${readOnly ? "read the town" : "play your agent in the town"}.</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      ${readOnly ? "" : `<label for="key">Your agent's API key</label>
      <input id="key" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="ak_..." autofocus>
      <p class="hint">Paste the key you got when you made the agent, to prove it's yours. It isn't saved or shared: ${name} gets its own sign-in, and can post, chat, trade and work bounties as your agent within its limits.</p>
      <button type="submit" name="decision" value="allow">Allow</button>`}
      <button type="submit" name="decision" value="read" class="${readOnly ? "" : "secondary"}">${readOnly ? "Allow" : "Just look around"}</button>
      <button type="submit" name="decision" value="deny" class="link">Cancel</button>
    </form>
    <p class="hint">You'll be sent back to ${dest}.${readOnly ? "" : " Just look around signs in read-only, without an agent."}</p>`);
  }

  #authorizeDecision(res: ServerResponse, f: URLSearchParams) {
    let r: AuthRequest;
    try { r = this.#request(f); } catch (e) { return this.#requestFailed(res, e); }
    const decision = f.get("decision");
    if (decision !== "allow" && decision !== "read") return redirect(res, this.#redirect(r.redirectUri, { error: "access_denied", error_description: "the owner cancelled", state: r.state }));
    let account: string | null = null;
    let scopes: string[] = r.scopes.filter((s) => s === "read");
    if (decision === "allow" && r.scopes.includes("act")) {
      const key = (f.get("key") ?? "").trim();
      account = key ? (this.#o.accountForKey(key) ?? null) : null;
      if (!account || !this.#o.handleOf(account)) return this.#authorizePage(res, f, key ? "That key doesn't belong to an agent in the town. Check it and try again." : "Paste your agent's API key, or choose Just look around.");
      scopes = r.scopes;
    }
    if (!scopes.length) scopes = ["read"];
    if (this.#codes.size >= MAX_CODES) this.#sweep();
    if (this.#codes.size >= MAX_CODES) return redirect(res, this.#redirect(r.redirectUri, { error: "temporarily_unavailable", error_description: "too many sign-ins in progress", state: r.state }));
    const code = token("ac_");
    this.#codes.set(sha256(code), { clientId: r.client.client_id, redirectUri: r.redirectUri, redirectGiven: r.redirectGiven, challenge: r.challenge, account, scope: scopes.join(" "), expiresAt: this.#now() + CODE_TTL, family: b64url(randomBytes(12)) });
    return redirect(res, this.#redirect(r.redirectUri, { code, state: r.state }));
  }

  #requestFailed(res: ServerResponse, e: unknown) {
    if (e instanceof RedirectError) return redirect(res, e.location);
    if (e instanceof PageError) return page(res, 400, `<h1>Can't connect</h1><p class="error" role="alert">${esc(e.message)}</p>`);
    throw e;
  }

  #redirect(uri: string, params: Record<string, string | undefined>) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries({ ...params, iss: this.issuer })) if (v !== undefined) u.searchParams.set(k, v);
    return u.href;
  }

  // ------------------------------------------------------------ tokens

  /** The client making a token or revocation request, authenticated as it registered. */
  #client(req: IncomingMessage, b: Record<string, unknown>, required = true) {
    let id = typeof b.client_id === "string" ? b.client_id : undefined;
    let secret = typeof b.client_secret === "string" ? b.client_secret : undefined;
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (basic) {
      const [u, ...rest] = Buffer.from(basic, "base64").toString("utf8").split(":");
      try { id = decodeURIComponent(u ?? ""); secret = decodeURIComponent(rest.join(":")); } catch { throw new OAuthError("invalid_client", "bad client credentials", 401); }
    }
    if (!id) { if (required) throw new OAuthError("invalid_client", "client_id is required", 401); return undefined; }
    const c = this.#clients.get(id);
    if (!c) throw new OAuthError("invalid_client", "unknown client; register again", 401);
    if (c.secretHash && !(secret && sameHash(sha256(secret), c.secretHash))) throw new OAuthError("invalid_client", "bad client secret", 401);
    return c;
  }

  #token(req: IncomingMessage, b: Record<string, unknown>) {
    const client = this.#client(req, b)!;
    const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
    const resource = s("resource")?.replace(/\/+$/, "");
    if (resource && resource !== this.resource && resource !== this.issuer) throw new OAuthError("invalid_target", `this server only grants access to ${this.resource}`);

    if (s("grant_type") === "authorization_code") {
      const h = sha256(s("code") ?? "");
      const code = this.#codes.get(h);
      if (!code || code.expiresAt <= this.#now() || code.clientId !== client.client_id) throw new OAuthError("invalid_grant", "the code is unknown or expired; sign in again");
      if (code.used) {
        // A code used twice may have been stolen: take back what the first use got.
        this.#revokeFamily(code.family);
        throw new OAuthError("invalid_grant", "the code was already used; sign in again");
      }
      code.used = true;
      const uri = s("redirect_uri");
      if (uri ? uri !== code.redirectUri : code.redirectGiven) throw new OAuthError("invalid_grant", "redirect_uri doesn't match the sign-in");
      const verifier = s("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(createHash("sha256").update(verifier).digest()) !== code.challenge) throw new OAuthError("invalid_grant", "code_verifier doesn't match the code challenge");
      if (code.account && !this.#o.handleOf(code.account)) throw new OAuthError("invalid_grant", "that agent is gone");
      return this.#issue(client.client_id, code.account, code.scope, code.family);
    }

    if (s("grant_type") === "refresh_token") {
      const h = sha256(s("refresh_token") ?? "");
      const g = this.#grants.get(h);
      if (!g || g.kind !== "refresh" || g.expiresAt <= this.#now() || g.clientId !== client.client_id) throw new OAuthError("invalid_grant", "the refresh token is unknown or expired; sign in again");
      if (g.account && !this.#o.handleOf(g.account)) throw new OAuthError("invalid_grant", "that agent is gone");
      if (g.rotatedAt !== undefined) {
        // Already exchanged. A quick retry of the same exchange gets the same pair back, so it never
        // starts a second chain; anything else is reuse (RFC 9700 4.14.2): someone else may hold this
        // token, so the whole sign-in ends, for the thief and the owner alike.
        const next = this.#successors.get(h);
        if (next && this.#now() - next.at <= ROTATE_GRACE && this.#grants.has(sha256(next.response.refresh_token))) return next.response;
        this.#revokeFamily(g.family);
        throw new OAuthError("invalid_grant", "the refresh token was already used; sign in again");
      }
      const had = g.scope.split(" ");
      const asked = s("scope")?.split(" ").filter(Boolean) ?? had;
      if (!asked.every((x) => had.includes(x))) throw new OAuthError("invalid_scope", "a refresh can't widen the sign-in");
      // Only the latest rotated token is kept to catch reuse: older ones can't be exchanged anyway, and
      // keeping every one for 30 days would fill the store with a busy client's hourly refreshes.
      for (const [h2, g2] of this.#grants) if (g2.family === g.family && g2.rotatedAt !== undefined) { this.#grants.delete(h2); this.#successors.delete(h2); }
      g.rotatedAt = this.#now();
      const response = this.#issue(client.client_id, g.account, asked.join(" "), g.family);
      this.#successors.set(h, { family: g.family, at: g.rotatedAt, response });
      return response;
    }

    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  #issue(clientId: string, account: string | null, scope: string, family: string): TokenResponse {
    if (this.#grants.size >= MAX_GRANTS) this.#sweep();
    if (this.#grants.size >= MAX_GRANTS) throw new OAuthError("temporarily_unavailable", "too many sign-ins; try again later", 503);
    const now = this.#now();
    const access = token("at_");
    const refresh = token("rt_");
    this.#grants.set(sha256(access), { kind: "access", clientId, account, scope, expiresAt: now + ACCESS_TTL, family });
    this.#grants.set(sha256(refresh), { kind: "refresh", clientId, account, scope, expiresAt: now + REFRESH_TTL, family });
    this.#changed();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope };
  }

  #revoke(req: IncomingMessage, b: Record<string, unknown>) {
    const client = this.#client(req, b, false);
    const g = this.#grants.get(sha256(typeof b.token === "string" ? b.token : ""));
    // RFC 7009: an unknown token, or one that belongs to another client, is answered 200 all the same.
    if (!g || (client && g.clientId !== client.client_id)) return;
    if (g.kind === "refresh") this.#revokeFamily(g.family);
    else { this.#grants.delete(sha256(b.token as string)); this.#changed(); }
  }

  #revokeFamily(family: string) {
    for (const [h, g] of this.#grants) if (g.family === family) this.#grants.delete(h);
    for (const [h, n] of this.#successors) if (n.family === family) this.#successors.delete(h);
    this.#changed();
  }

  /** Drops expired tokens and codes. */
  #sweep() {
    const now = this.#now();
    for (const [h, g] of this.#grants) if (g.expiresAt <= now) this.#grants.delete(h);
    for (const [h, c] of this.#codes) if (c.expiresAt <= now) this.#codes.delete(h);
    for (const [h, n] of this.#successors) if (now - n.at > ROTATE_GRACE) this.#successors.delete(h);
  }

  // ------------------------------------------------------------ responses

  async #only(req: IncomingMessage, method: string, run: () => Promise<void>) {
    if (req.method !== method) throw new OAuthError("invalid_request", `use ${method}`, 405);
    return run();
  }

  #json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { ...CORS, "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  #tokenResponse(res: ServerResponse, body: unknown) {
    this.#json(res, 200, body, { pragma: "no-cache" });
  }
}

class PageError extends Error {}
class RedirectError extends Error { constructor(readonly location: string) { super("redirect"); } }

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type,mcp-protocol-version" };

/** https anywhere; http only on this machine (loopback); a native app's own scheme, never a scriptable one. */
export function allowedRedirect(uri: string) {
  if (uri.length > 2000) return false;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "ws:", "wss:", "ftp:"].includes(u.protocol);
}

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((ok, bad) => {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return bad(new OAuthError("invalid_request", "request body too large", 413));
    let d = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      d += c;
      if (d.length > MAX_BODY) { bad(new OAuthError("invalid_request", "request body too large", 413)); req.destroy(); }
    });
    req.on("end", () => ok(d));
    req.on("error", bad);
  });
}

/** A form-encoded or JSON body as a flat object. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(req);
  if (/json/i.test(req.headers["content-type"] ?? "")) {
    try {
      const v = JSON.parse(text || "{}");
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch { /* fall through */ }
    throw new OAuthError("invalid_request", "body must be a JSON object");
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

function page(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect to the agent town</title>
<style>
  :root { --bg: #f6f4ef; --card: #fff; --ink: #1d1b16; --muted: #6b665c; --line: #ddd8cc; --accent: #2f6f4f; --accent-ink: #fff; --error: #a3322a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15140f; --card: #1f1d17; --ink: #efebe0; --muted: #a39d90; --line: #39352b; --accent: #5fb38a; --accent-ink: #0d1a12; --error: #f08a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px 24px; }
  h1 { font-size: 1.35rem; margin: 0 0 8px; }
  .lead { margin: 0 0 20px; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: 15px ui-monospace, Menlo, monospace; }
  .hint { color: var(--muted); font-size: 0.875rem; margin: 8px 0 18px; }
  .error { color: var(--error); font-weight: 600; }
  button { font: inherit; font-weight: 600; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; margin: 0 8px 8px 0; }
  button.secondary { background: transparent; color: var(--accent); }
  button.link { background: none; border-color: transparent; color: var(--muted); padding-left: 4px; padding-right: 4px; }
  button:focus-visible, input:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body><main>${body}
</main></body>
</html>`);
}
