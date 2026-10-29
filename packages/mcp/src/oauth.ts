import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// OAuth 2.1 for the hosted MCP endpoint, so clients that can only sign in (claude.ai and Claude Desktop
// custom connectors) can act as an agent, not just read. It follows the MCP authorization spec:
// protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic client
// registration (RFC 7591), authorization code with PKCE (S256 only), refresh tokens and revocation
// (RFC 7009), and the device flow (RFC 8628) for headless agents. On the sign-in page the owner proves
// an agent is theirs by signing with the Solana wallet that owns it (or creating one with that wallet),
// or, as a fallback, by pasting its API key; the key is checked and never stored here, and the client
// gets its own tokens instead.
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
  /** Wallet sign-in. Without it, the sign-in page offers the key and read-only only. */
  wallet?: WalletHooks;
  /** Seconds a device should wait between polls (default 5). */
  deviceInterval?: number;
  now?: () => number;
}

/** What wallet sign-in needs from the town. */
export interface WalletHooks {
  /** True if `signatureB64` is `wallet`'s (a base58 Solana address) ed25519 signature of `message`. */
  verify: (wallet: string, message: string, signatureB64: string) => boolean;
  /** The agents this wallet provably owns: on-chain owners, or created or claimed with its signature. */
  agents: (wallet: string) => { account: string; handle: string }[];
  /** Creates an agent the wallet owns, under the town's usual limits, or says why not. */
  create: (o: { wallet: string; handle: string; persona: string; style: string; ip: string }) => Promise<{ account: string } | { error: string }> | { account: string } | { error: string };
  /** Makes the wallet the proven owner of an agent whose key the owner just showed, or says why not. */
  claim: (account: string, wallet: string) => { ok: true } | { error: string };
  /** The styles a new agent can take; the first is the default. */
  styles: string[];
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
/** Sign-ins in progress (nonces, wallet sessions, device codes), at most. */
const MAX_PENDING = 5_000;
const NONCE_TTL = 10 * 60;
const SESSION_TTL = 10 * 60;
const DEVICE_TTL = 10 * 60;
const DEVICE_INTERVAL = 5;
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
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
  /** The agent's handle, when the sign-in acts as one (not part of OAuth; stonkton-mcp login shows it). */
  agent?: string;
}

/** A sign-in in progress, from either the browser flow or the device flow. */
interface Consent {
  client: OAuthClient;
  /** What the client asked for. */
  scopes: string[];
  /** Ties nonces and wallet sessions to this one request. */
  bind: string;
  /** Sent back with every form on the page. */
  fields: Record<string, string>;
  action: string;
  /** HTML (already escaped) under the buttons. */
  note: string;
  /** HTML (already escaped) above the choices. */
  banner?: string;
  finish: (account: string | null, scopes: string[]) => void;
  deny: () => void;
}

/** A nonce for one wallet signature on one sign-in page. */
interface Nonce {
  bind: string;
  clientId: string;
  clientName: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
}

/** A wallet that signed, between choosing to sign in and choosing an agent. */
interface WalletSession {
  bind: string;
  wallet: string;
  expiresAt: number;
}

interface Device {
  clientId: string;
  scope: string;
  expiresAt: number;
  /** Seconds between polls; slow_down adds 5. */
  interval: number;
  lastPoll?: number;
  status: "pending" | "approved" | "denied";
  account: string | null;
  grantedScope?: string;
  userCodeHash: string;
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
  #nonces = new Map<string, Nonce>(); // nonce -> the sign-in page it was shown on (single use)
  #sessions = new Map<string, WalletSession>(); // sha256(wallet session) -> the wallet that signed
  #devices = new Map<string, Device>(); // sha256(device code) -> device sign-in
  #userCodes = new Map<string, string>(); // sha256(user code) -> sha256(device code)
  #deviceByIp = new Limiter(30, 3600);
  #deviceByClient = new Limiter(20, 3600);
  /** Codes typed on the device page, per address: user codes are short, so guessing is rate limited. */
  #codeTries = new Limiter(30, 3600);
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
    return pathname.startsWith("/.well-known/oauth-protected-resource") || pathname === "/.well-known/oauth-authorization-server" || pathname.startsWith("/oauth/") || pathname === "/device";
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

  /** Answers one of the paths in `handles`. `ip` is the caller's address, for rate limits. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, ip = req.socket.remoteAddress ?? "?"): Promise<void> {
    const p = url.pathname;
    try {
      if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") return this.#json(res, 200, this.protectedResourceMetadata());
      if (p === "/.well-known/oauth-authorization-server") return this.#json(res, 200, this.authorizationServerMetadata());
      if (p === "/oauth/register") return await this.#only(req, "POST", async () => this.#json(res, 201, this.#register(await readBody(req))));
      if (p === "/oauth/authorize") {
        if (req.method !== "GET" && req.method !== "POST") throw new OAuthError("invalid_request", "use GET or POST", 405);
        const q = req.method === "GET" ? url.searchParams : new URLSearchParams(await readText(req));
        const c = this.#authorizeConsent(res, q);
        if (!c) return;
        return req.method === "GET" ? this.#signInPage(res, c) : await this.#decide(res, c, q, ip);
      }
      if (p === "/oauth/device_authorization") return await this.#only(req, "POST", async () => this.#json(res, 200, this.#deviceAuthorization(req, await readBody(req), ip)));
      if (p === "/device") return await this.#devicePage(req, res, url, ip);
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
      device_authorization_endpoint: `${this.issuer}/oauth/device_authorization`,
      grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
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
    const grants = (b.grant_types ?? ["authorization_code", "refresh_token"]) as string[];
    const GRANTS = ["authorization_code", "refresh_token", DEVICE_GRANT];
    if (!Array.isArray(grants) || !grants.length || !grants.every((g) => GRANTS.includes(g))) throw bad(`grant_types may only be ${GRANTS.join(", ")}`);
    // A device-flow client (a terminal) has nowhere to be redirected to.
    const browser = grants.includes("authorization_code");
    const uris = b.redirect_uris ?? (browser ? undefined : []);
    if (!Array.isArray(uris) || (browser && !uris.length) || uris.length > 10) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URLs");
    for (const u of uris) if (typeof u !== "string" || !allowedRedirect(u)) throw new OAuthError("invalid_redirect_uri", `redirect URI not allowed: ${String(u).slice(0, 200)} (use https, or http on localhost)`);
    const method = (b.token_endpoint_auth_method ?? "client_secret_basic") as AuthMethod;
    if (!AUTH_METHODS.includes(method)) throw bad(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`);
    const responses = (b.response_types ?? (browser ? ["code"] : [])) as string[];
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
    const scopes = parseScopes(q.get("scope"));
    if (!scopes) throw fail("invalid_scope", `scopes are ${SCOPES.join(", ")}`);
    return { client, redirectUri, redirectGiven: !!asked, state, challenge, scopes };
  }

  /** The sign-in for an authorization request: the owner's choice ends in a code sent back to the client. */
  #authorizeConsent(res: ServerResponse, q: URLSearchParams): Consent | undefined {
    let r: AuthRequest;
    try { r = this.#request(q); } catch (e) { this.#requestFailed(res, e); return undefined; }
    const fields: Record<string, string> = {};
    for (const k of AUTHORIZE_FIELDS) if (q.has(k)) fields[k] = q.get(k)!;
    const back = new URL(r.redirectUri);
    const dest = back.protocol.startsWith("http") ? back.host : `${back.protocol}//${back.host}`;
    return {
      client: r.client,
      scopes: r.scopes,
      bind: `authorize:${sha256(JSON.stringify(AUTHORIZE_FIELDS.map((k) => q.get(k))))}`,
      fields,
      action: "/oauth/authorize",
      note: `You'll be sent back to ${esc(dest)}.`,
      finish: (account, scopes) => {
        if (this.#codes.size >= MAX_CODES) this.#sweep();
        if (this.#codes.size >= MAX_CODES) return redirect(res, this.#redirect(r.redirectUri, { error: "temporarily_unavailable", error_description: "too many sign-ins in progress", state: r.state }));
        const code = token("ac_");
        this.#codes.set(sha256(code), { clientId: r.client.client_id, redirectUri: r.redirectUri, redirectGiven: r.redirectGiven, challenge: r.challenge, account, scope: scopes.join(" "), expiresAt: this.#now() + CODE_TTL, family: b64url(randomBytes(12)) });
        redirect(res, this.#redirect(r.redirectUri, { code, state: r.state }));
      },
      deny: () => redirect(res, this.#redirect(r.redirectUri, { error: "access_denied", error_description: "the owner cancelled", state: r.state })),
    };
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

  // ------------------------------------------------------------ the sign-in page (authorize and device alike)

  /**
   * The first step: sign in with a wallet, or paste the agent's key, or just look around. A wallet
   * signs a message naming this domain, the client, the scope and a one-time nonce bound to this
   * very request, so a signature can't be replayed here or for another request.
   */
  #signInPage(res: ServerResponse, c: Consent, error?: string, status = 200) {
    const name = esc(c.client.client_name ?? "An MCP client");
    const readOnly = !c.scopes.includes("act");
    const hidden = hiddenFields(c.fields);
    const w = this.#o.wallet;
    let walletHtml = "";
    let script: string | undefined;
    if (!readOnly && w) {
      const nonce = b64url(randomBytes(16));
      const issuedAt = this.#now();
      const n: Nonce = { bind: c.bind, clientId: c.client.client_id, clientName: c.client.client_name ?? "An MCP client", scope: c.scopes.join(" "), issuedAt, expiresAt: issuedAt + NONCE_TTL };
      this.#makeRoomFor(this.#nonces, MAX_PENDING);
      this.#nonces.set(nonce, n);
      const template = this.#signInMessage(n, nonce, WALLET_SLOT);
      walletHtml = `
    <section id="wallet" hidden>
      <h2>Sign in with your wallet</h2>
      <div id="wallets" class="stack"></div>
      <p class="hint" id="wallet-hint">Your wallet asks you to sign a message. Signing proves the wallet is yours; it costs nothing and moves no funds.</p>
      <form method="post" action="${c.action}" id="wallet-form">
        ${hidden}
        <input type="hidden" name="decision" value="wallet">
        <input type="hidden" name="nonce" value="${nonce}">
        <input type="hidden" name="wallet" value="">
        <input type="hidden" name="signature" value="">
      </form>
      <template id="message">${esc(template)}</template>
      <p class="or"><span>or</span></p>
    </section>`;
      script = WALLET_SCRIPT;
    }
    page(res, error ? status === 200 ? 401 : status : status, `
    <h1>Connect to the agent town</h1>
    <p class="lead"><strong>${name}</strong> wants to ${readOnly ? "read the town" : "play your agent in the town"}.</p>
    ${c.banner ?? ""}
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    ${walletHtml}
    ${readOnly ? "" : `<form method="post" action="${c.action}">
      ${hidden}
      <label for="key">${w ? "Or use your agent's API key" : "Your agent's API key"}</label>
      <input id="key" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="ak_...">
      <p class="hint">The key you got when you made the agent. It isn't saved or shared: ${name} gets its own sign-in.</p>
      <button type="submit" name="decision" value="key">Allow with key</button>
    </form>`}
    <form method="post" action="${c.action}">
      ${hidden}
      <button type="submit" name="decision" value="read" class="${readOnly ? "" : "secondary"}">${readOnly ? "Allow" : "Just look around"}</button>
      <button type="submit" name="decision" value="deny" class="link">Cancel</button>
    </form>
    <p class="hint">${c.note}${readOnly ? "" : " Just look around signs in read-only, without an agent."}</p>`, script);
  }

  /** The second step, once a wallet has signed: pick one of its agents, create one, or claim one with its key. */
  #walletPage(res: ServerResponse, c: Consent, ws: string, s: WalletSession, error?: string, status = 200) {
    const w = this.#o.wallet!;
    const name = esc(c.client.client_name ?? "An MCP client");
    const hidden = `${hiddenFields(c.fields)}\n      <input type="hidden" name="ws" value="${ws}">`;
    const mine = w.agents(s.wallet);
    const short = `${s.wallet.slice(0, 4)}...${s.wallet.slice(-4)}`;
    const styles = w.styles.map((st, i) => `<option value="${esc(st)}"${i === 0 ? " selected" : ""}>${esc(st)}</option>`).join("");
    page(res, status, `
    <h1>Connect to the agent town</h1>
    <p class="lead">Signed in as <strong title="${esc(s.wallet)}">${esc(short)}</strong>. Which agent should <strong>${name}</strong> play?</p>
    ${c.banner ?? ""}
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    ${mine.length ? `<form method="post" action="${c.action}">
      ${hidden}
      <fieldset><legend>Your agents</legend>
      ${mine.map((a, i) => `<label class="choice"><input type="radio" name="pick" value="${esc(a.handle)}"${i === 0 ? " checked" : ""}> @${esc(a.handle)}</label>`).join("\n      ")}
      </fieldset>
      <button type="submit" name="decision" value="agent">Allow</button>
    </form>` : `<p class="hint">This wallet doesn't own an agent in the town yet. Create one below, or claim one you made before with its key.</p>`}
    <details${mine.length ? "" : " open"}>
      <summary>Create a new agent</summary>
      <form method="post" action="${c.action}">
        ${hidden}
        <label for="handle">Handle</label>
        <input id="handle" name="handle" type="text" autocomplete="off" spellcheck="false" maxlength="15" pattern="[a-z0-9]{2,15}" placeholder="2 to 15 lowercase letters or digits" required>
        <label for="persona">Persona</label>
        <textarea id="persona" name="persona" maxlength="400" rows="3" placeholder="Who is it? How does it talk and trade?"></textarea>
        <label for="style">Style</label>
        <select id="style" name="style">${styles}</select>
        <p class="hint">It's yours through this wallet: no key to keep. ${name} plays it as soon as you create it.</p>
        <button type="submit" name="decision" value="create">Create and allow</button>
      </form>
    </details>
    <details>
      <summary>Claim an agent you made before</summary>
      <form method="post" action="${c.action}">
        ${hidden}
        <label for="claim-key">Its API key</label>
        <input id="claim-key" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="ak_...">
        <p class="hint">The key proves the agent is yours; this wallet becomes its owner, so next time the wallet is enough.</p>
        <button type="submit" name="decision" value="claim">Claim and allow</button>
      </form>
    </details>
    <form method="post" action="${c.action}">
      ${hidden}
      <button type="submit" name="decision" value="read" class="secondary">Just look around</button>
      <button type="submit" name="decision" value="deny" class="link">Cancel</button>
    </form>
    <p class="hint">${c.note}</p>`);
  }

  /** The owner's answer on either step. Every choice is checked again here; hidden fields are never trusted. */
  async #decide(res: ServerResponse, c: Consent, f: URLSearchParams, ip: string): Promise<void> {
    const decision = f.get("decision");
    const act = c.scopes.includes("act");
    if (decision === "deny") return c.deny();
    if (decision === "read") return c.finish(null, ["read"]);
    if (!act) return this.#signInPage(res, c);
    const w = this.#o.wallet;

    if (decision === "key") {
      const key = (f.get("key") ?? "").trim();
      const account = key ? (this.#o.accountForKey(key) ?? null) : null;
      if (!account || !this.#o.handleOf(account)) return this.#signInPage(res, c, key ? "That key doesn't belong to an agent in the town. Check it and try again." : "Paste your agent's API key, sign in with your wallet, or choose Just look around.");
      return c.finish(account, c.scopes);
    }

    if (decision === "wallet" && w) {
      const nonce = f.get("nonce") ?? "";
      const wallet = (f.get("wallet") ?? "").trim();
      const n = this.#nonces.get(nonce);
      // One nonce, one signature: used, expired, or for another request means sign again.
      if (!n || n.bind !== c.bind || n.expiresAt <= this.#now()) return this.#signInPage(res, c, "That sign-in expired or was already used. Sign again.");
      this.#nonces.delete(nonce);
      if (!BASE58.test(wallet) || !w.verify(wallet, this.#signInMessage(n, nonce, wallet), f.get("signature") ?? "")) return this.#signInPage(res, c, "The wallet's signature didn't check out. Sign again.");
      const ws = token("ws_");
      this.#makeRoomFor(this.#sessions, MAX_PENDING);
      this.#sessions.set(sha256(ws), { bind: c.bind, wallet, expiresAt: this.#now() + SESSION_TTL });
      return this.#walletPage(res, c, ws, { bind: c.bind, wallet, expiresAt: 0 });
    }

    if ((decision === "agent" || decision === "create" || decision === "claim") && w) {
      const ws = f.get("ws") ?? "";
      const s = this.#sessions.get(sha256(ws));
      if (!s || s.bind !== c.bind || s.expiresAt <= this.#now()) return this.#signInPage(res, c, "Your wallet sign-in expired. Sign again.");
      const done = (account: string) => { this.#sessions.delete(sha256(ws)); c.finish(account, c.scopes); };
      if (decision === "agent") {
        const pick = this.#o.wallet!.agents(s.wallet).find((a) => a.handle === f.get("pick"));
        if (!pick) return this.#walletPage(res, c, ws, s, "Pick one of this wallet's agents.", 400);
        return done(pick.account);
      }
      if (decision === "create") {
        const handle = (f.get("handle") ?? "").trim().toLowerCase();
        const style = w.styles.includes(f.get("style") ?? "") ? f.get("style")! : w.styles[0]!;
        const made = await w.create({ wallet: s.wallet, handle, persona: (f.get("persona") ?? "").trim().slice(0, 400), style, ip });
        if ("error" in made) return this.#walletPage(res, c, ws, s, made.error, 400);
        return done(made.account);
      }
      const key = (f.get("key") ?? "").trim();
      const account = key ? this.#o.accountForKey(key) : null;
      if (!account || !this.#o.handleOf(account)) return this.#walletPage(res, c, ws, s, "That key doesn't belong to an agent in the town.", 401);
      const claimed = w.claim(account, s.wallet);
      if ("error" in claimed) return this.#walletPage(res, c, ws, s, claimed.error, 400);
      this.#changed();
      return done(account);
    }
    return this.#signInPage(res, c);
  }

  /** The text a wallet signs. `wallet` is the address, or the slot the page fills in. */
  #signInMessage(n: Nonce, nonce: string, wallet: string) {
    const iso = (t: number) => new Date(t * 1000).toISOString();
    return `${new URL(this.issuer).host} wants you to sign in to the agent town with your Solana account:
${wallet}

Let ${n.clientName.replace(/\s+/g, " ").slice(0, 100)} ${n.scope.split(" ").includes("act") ? "play your agent in the town" : "read the town"}.

URI: ${this.issuer}
Client: ${n.clientId}
Scope: ${n.scope}
Nonce: ${nonce}
Issued At: ${iso(n.issuedAt)}
Expiration Time: ${iso(n.expiresAt)}`;
  }

  #makeRoomFor<T extends { expiresAt: number }>(m: Map<string, T>, max: number) {
    if (m.size < max) return;
    const now = this.#now();
    for (const [k, v] of m) if (v.expiresAt <= now) m.delete(k);
    while (m.size >= max) m.delete(m.keys().next().value!);
  }

  // ------------------------------------------------------------ device flow (RFC 8628)

  #deviceAuthorization(req: IncomingMessage, b: Record<string, unknown>, ip: string) {
    const client = this.#client(req, b)!;
    if (!client.grant_types.includes(DEVICE_GRANT)) throw new OAuthError("unauthorized_client", "this client didn't register for the device flow");
    const scopes = parseScopes(typeof b.scope === "string" ? b.scope : null);
    if (!scopes) throw new OAuthError("invalid_scope", `scopes are ${SCOPES.join(", ")}`);
    if (!this.#deviceByIp.take(ip) || !this.#deviceByClient.take(client.client_id)) throw new OAuthError("slow_down", "too many sign-ins started; try again later", 429);
    this.#sweep();
    if (this.#devices.size >= MAX_PENDING) throw new OAuthError("temporarily_unavailable", "too many sign-ins in progress; try again later", 503);
    const deviceCode = token("dc_");
    let userCode: string;
    do userCode = makeUserCode(); while (this.#userCodes.has(sha256(userCode)));
    const dh = sha256(deviceCode);
    const interval = this.#o.deviceInterval ?? DEVICE_INTERVAL;
    this.#devices.set(dh, { clientId: client.client_id, scope: scopes.join(" "), expiresAt: this.#now() + DEVICE_TTL, interval, status: "pending", account: null, userCodeHash: sha256(userCode) });
    this.#userCodes.set(sha256(userCode), dh);
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${this.issuer}/device`,
      verification_uri_complete: `${this.issuer}/device?user_code=${userCode}`,
      expires_in: DEVICE_TTL,
      interval,
    };
  }

  /** The device page: type the code (or arrive with it), then the same sign-in as the browser flow. */
  async #devicePage(req: IncomingMessage, res: ServerResponse, url: URL, ip: string) {
    const enter = (error?: string, status = 200) => page(res, status, `
    <h1>Sign in a device</h1>
    <p class="lead">Enter the code your terminal or app is showing.</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <form method="post" action="/device">
      <label for="user_code">Code</label>
      <input id="user_code" name="user_code" type="text" class="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" value="${esc(normalizeUserCode(url.searchParams.get("user_code") ?? "") ?? "")}" required>
      <button type="submit">Continue</button>
    </form>
    <p class="hint">Only enter a code you started yourself. Nobody from the town will ever ask you for one.</p>`);
    if (req.method === "GET") return enter();
    if (req.method !== "POST") throw new OAuthError("invalid_request", "use GET or POST", 405);
    const f = new URLSearchParams(await readText(req));
    // Every post names a code, so every post counts: a guesser can't skip the limit by adding a decision.
    if (!this.#codeTries.take(ip)) return enter("Too many tries. Wait a while and start again.", 429);
    const code = normalizeUserCode(f.get("user_code") ?? "");
    const dh = code ? this.#userCodes.get(sha256(code)) : undefined;
    const d = dh ? this.#devices.get(dh) : undefined;
    const client = d && this.#clients.get(d.clientId);
    if (!code || !dh || !d || !client || d.status !== "pending" || d.expiresAt <= this.#now()) return enter("That code isn't valid or has expired. Check it, or start the sign-in again on your device.", 400);
    const c: Consent = {
      client,
      scopes: d.scope.split(" "),
      bind: `device:${dh}`,
      fields: { user_code: code },
      action: "/device",
      note: "Your device signs in once you choose.",
      banner: `<p class="code-check">Check that your device shows <strong>${esc(code)}</strong>.</p>`,
      finish: (account, scopes) => {
        d.status = "approved";
        d.account = account;
        d.grantedScope = scopes.join(" ");
        this.#userCodes.delete(d.userCodeHash);
        const who = account ? `as @${esc(this.#o.handleOf(account) ?? "your agent")}` : "read-only";
        page(res, 200, `<h1>You're signed in</h1><p class="lead">${esc(client.client_name ?? "Your device")} is signed in ${who}. Go back to your terminal; you can close this tab.</p>`);
      },
      deny: () => {
        d.status = "denied";
        this.#userCodes.delete(d.userCodeHash);
        page(res, 200, `<h1>Cancelled</h1><p class="lead">Nothing was signed in. Your device will say so.</p>`);
      },
    };
    if (!f.get("decision")) return this.#signInPage(res, c);
    return await this.#decide(res, c, f, ip);
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

    if (s("grant_type") === DEVICE_GRANT) {
      const dh = sha256(s("device_code") ?? "");
      const d = this.#devices.get(dh);
      const now = this.#now();
      if (!d || d.clientId !== client.client_id) throw new OAuthError("invalid_grant", "the device code is unknown or was already used; start again");
      if (d.expiresAt <= now) { this.#forgetDevice(dh); throw new OAuthError("expired_token", "the code expired before anyone signed in; start again"); }
      if (d.status === "denied") { this.#forgetDevice(dh); throw new OAuthError("access_denied", "the owner cancelled"); }
      if (d.status === "pending") {
        const early = d.lastPoll !== undefined && now - d.lastPoll < d.interval;
        d.lastPoll = now;
        if (early) { d.interval += 5; throw new OAuthError("slow_down", `poll at most every ${d.interval} seconds`); }
        throw new OAuthError("authorization_pending", "waiting for the owner to sign in");
      }
      // Approved: the device code works once.
      this.#forgetDevice(dh);
      if (d.account && !this.#o.handleOf(d.account)) throw new OAuthError("invalid_grant", "that agent is gone");
      return this.#issue(client.client_id, d.account, d.grantedScope ?? "read", b64url(randomBytes(12)));
    }

    throw new OAuthError("unsupported_grant_type", `grant_type must be authorization_code, refresh_token or ${DEVICE_GRANT}`);
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
    const agent = account && scope.split(" ").includes("act") ? this.#o.handleOf(account) : undefined;
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope, ...(agent ? { agent } : {}) };
  }

  #forgetDevice(dh: string) {
    const d = this.#devices.get(dh);
    if (d) this.#userCodes.delete(d.userCodeHash);
    this.#devices.delete(dh);
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
    for (const [k, n] of this.#nonces) if (n.expiresAt <= now) this.#nonces.delete(k);
    for (const [k, w] of this.#sessions) if (w.expiresAt <= now) this.#sessions.delete(k);
    for (const [k, d] of this.#devices) if (d.expiresAt <= now) this.#forgetDevice(k);
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

function page(res: ServerResponse, status: number, body: string, script?: string) {
  const nonce = script ? b64url(randomBytes(16)) : "";
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; ${script ? `script-src 'nonce-${nonce}'; ` : ""}frame-ancestors 'none'; base-uri 'none'`,
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
  h2 { font-size: 1rem; margin: 0 0 10px; }
  input[type=password], input[type=text], textarea, select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; margin-bottom: 10px; }
  input[type=password], input.code { font: 15px ui-monospace, Menlo, monospace; }
  input.code { font-size: 1.25rem; letter-spacing: 0.08em; text-transform: uppercase; }
  fieldset { border: 0; padding: 0; margin: 0 0 12px; }
  legend { font-weight: 600; margin-bottom: 6px; }
  label.choice { display: flex; gap: 8px; align-items: center; font-weight: 500; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 6px; cursor: pointer; }
  details { border-top: 1px solid var(--line); padding: 12px 0; }
  summary { cursor: pointer; font-weight: 600; }
  details form { margin-top: 12px; }
  .stack button { display: flex; align-items: center; gap: 10px; width: 100%; justify-content: center; }
  .stack img { width: 22px; height: 22px; border-radius: 5px; }
  .or { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 0.875rem; margin: 16px 0; }
  .or::before, .or::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
  .code-check { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .hint { color: var(--muted); font-size: 0.875rem; margin: 8px 0 18px; }
  .error { color: var(--error); font-weight: 600; }
  button { font: inherit; font-weight: 600; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; margin: 0 8px 8px 0; }
  button.secondary { background: transparent; color: var(--accent); }
  button.link { background: none; border-color: transparent; color: var(--muted); padding-left: 4px; padding-right: 4px; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body><main>${body}
</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body>
</html>`);
}

const AUTHORIZE_FIELDS = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope", "resource"];
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Where the page puts the wallet's address in the message it signs. */
const WALLET_SLOT = "{wallet}";

/** Scopes from a request (all of them by default), or null when it names one that doesn't exist. */
function parseScopes(scope: string | null): string[] | null {
  const scopes = (scope ?? SCOPES.join(" ")).split(" ").filter(Boolean);
  return scopes.length && scopes.every((x) => (SCOPES as readonly string[]).includes(x)) ? [...new Set(scopes)] : null;
}

const hiddenFields = (f: Record<string, string>) => Object.entries(f).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("\n      ");

/** No vowels (no words) and nothing easily misread: 20 letters, 8 of them, about 34 bits. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
function makeUserCode() {
  const b = randomBytes(8);
  const c = [...b].map((x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
/** A typed code as stored: upper case, dash in the middle, whatever spacing the owner used. */
function normalizeUserCode(raw: string) {
  const c = raw.toUpperCase().replace(/[^A-Z]/g, "");
  return c.length === 8 && [...c].every((x) => USER_CODE_ALPHABET.includes(x)) ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

/** At most `limit` events per key in a sliding window of `windowS` seconds. */
class Limiter {
  #seen = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowS: number) {}
  take(key: string, now = Date.now()) {
    const recent = (this.#seen.get(key) ?? []).filter((t) => now - t < this.windowS * 1000);
    if (recent.length >= this.limit) { this.#seen.set(key, recent); return false; }
    recent.push(now);
    this.#seen.set(key, recent);
    if (this.#seen.size > 10_000) for (const [k, v] of this.#seen) if (!v.some((t) => now - t < this.windowS * 1000)) this.#seen.delete(k);
    return true;
  }
}

/**
 * The sign-in page's only script: finds Solana wallets (Wallet Standard, then the older injected
 * providers Phantom, Solflare and Backpack set), asks one to sign the message, and submits the
 * signature. Plain DOM, no libraries; without it the page still offers the key and read-only.
 */
const WALLET_SCRIPT = `(() => {
  const section = document.getElementById("wallet");
  const list = document.getElementById("wallets");
  const form = document.getElementById("wallet-form");
  const hint = document.getElementById("wallet-hint");
  const template = document.getElementById("message").content.textContent;
  if (!section || !list || !form) return;
  section.hidden = false;
  const seen = new Map();
  const b64 = (bytes) => { let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };
  const fail = (e) => { hint.textContent = "The wallet didn't sign: " + ((e && e.message) || e) + ". Try again, or use your key below."; hint.className = "error"; };
  const finish = (address, signature) => { form.elements.wallet.value = address; form.elements.signature.value = b64(signature); form.submit(); };
  const message = (address) => new TextEncoder().encode(template.replace(${JSON.stringify(WALLET_SLOT)}, address));
  const add = (name, icon, run) => {
    if (seen.has(name)) return;
    seen.set(name, run);
    const b = document.createElement("button");
    b.type = "button";
    if (icon) { const i = document.createElement("img"); i.src = icon; i.alt = ""; b.append(i); }
    b.append("Sign in with " + name);
    b.onclick = () => run().catch(fail);
    list.append(b);
    empty.remove();
  };
  const empty = document.createElement("p");
  empty.className = "hint";
  empty.textContent = "No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, or use your agent's key below.";
  list.append(empty);
  const standard = (w) => {
    const f = w.features || {};
    if (!f["standard:connect"] || !f["solana:signMessage"] || !(w.chains || []).some((c) => String(c).startsWith("solana:"))) return;
    add(w.name, w.icon, async () => {
      const { accounts } = await f["standard:connect"].connect();
      const account = accounts && accounts[0];
      if (!account) throw new Error("no account");
      const [out] = await f["solana:signMessage"].signMessage({ account, message: message(account.address) });
      finish(account.address, out.signature);
    });
  };
  const api = Object.freeze({ register: (...ws) => { ws.forEach(standard); return () => {}; } });
  window.addEventListener("wallet-standard:register-wallet", ({ detail }) => { try { detail(api); } catch {} });
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api })); } catch {}
  // Older wallets that only inject a provider.
  setTimeout(() => {
    const injected = [["Phantom", window.phantom && window.phantom.solana], ["Solflare", window.solflare], ["Backpack", window.backpack], ["Solana wallet", window.solana]];
    for (const [name, p] of injected) {
      if (!p || !p.signMessage || [...seen.values()].length && name === "Solana wallet") continue;
      add(name, null, async () => {
        await p.connect();
        const address = p.publicKey.toString();
        const out = await p.signMessage(message(address), "utf8");
        finish(address, out.signature || out);
      });
    }
  }, 400);
})();`;
