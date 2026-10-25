import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main, type Io } from "./cli.js";
import { loadAgent } from "./config.js";
import { handleMcpHttp } from "./http.js";
import { DEVICE_GRANT, TownOAuth } from "./oauth.js";
import { createServer } from "./server.js";
import { SignIn } from "./session.js";

// Signing in without pasting a key: a Solana wallet on the sign-in page (pick an agent it provably
// owns, create one, or claim an old one with its key), the device flow for headless agents, and
// `agents-mcp login` on top of it. Wallets are ed25519 keys generated here, signing exactly what the
// page asks a wallet extension to sign.

// ---------------------------------------------------------------- wallets

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58encode = (bytes: Uint8Array) => {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = `1${s}`; }
  return s;
};
const b58decode = (s: string) => {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("not base58"); n = n * 58n + BigInt(i); }
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
};
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

interface Wallet { address: string; key: KeyObject; sign: (message: string) => string }
function wallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { address: b58encode(raw), key: privateKey, sign: (m) => sign(null, Buffer.from(m, "utf8"), privateKey).toString("base64") };
}
/** The runtime's check (apps/runtime/src/enroll.ts verifySignature), on a base58 address. */
const verifyWallet = (address: string, message: string, sig: string) => {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI, b58decode(address)]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig, "base64"));
  } catch { return false; }
};

// ---------------------------------------------------------------- a small town

interface TownAgent { account: string; handle: string; owner: string; ownerVerified?: boolean; host?: boolean }
const KEY_ATLAS = `ak_${"a1".repeat(24)}`;
const KEY_ROOK = `ak_${"b2".repeat(24)}`;
const KEY_HOST = `ak_${"c3".repeat(24)}`;
const A = wallet();
const B = wallet();
let agents: Map<string, TownAgent>;
let keys: Map<string, string>;
let created: { ip: string }[];
let clock = Date.now();

function resetTown() {
  agents = new Map();
  const add = (a: TownAgent) => agents.set(a.account, a);
  // atlas names wallet A as its owner, but nobody proved it (POST /v1/agents takes any string).
  add({ account: "0xatlas", handle: "atlas", owner: A.address });
  // moss is A's, proven (on-chain, or created with A's signature).
  add({ account: "0xmoss", handle: "moss", owner: A.address, ownerVerified: true });
  // rook is A's, proven, and also has a key.
  add({ account: "0xrook", handle: "rook", owner: A.address, ownerVerified: true });
  add({ account: "0xoldman", handle: "theoldman", owner: "0xops", host: true });
  keys = new Map([[KEY_ATLAS, "0xatlas"], [KEY_ROOK, "0xrook"], [KEY_HOST, "0xoldman"]]);
  created = [];
}

const byHandle = (h: string) => [...agents.values()].find((a) => a.handle === h);

const calls: { url: string; auth?: string; body?: any }[] = [];
const api = (async (url: string, init?: RequestInit) => {
  calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.endsWith("/actions")) return Response.json({ results: [{ ok: true }] });
  return Response.json({ agents: [] });
}) as unknown as typeof fetch;

let http: Server;
let base: string;
let oauth: TownOAuth;
const newOAuth = () => new TownOAuth({
  issuer: base,
  accountForKey: (k) => keys.get(k),
  handleOf: (a) => agents.get(a)?.handle,
  now: () => clock,
  wallet: {
    verify: verifyWallet,
    agents: (w) => [...agents.values()].filter((a) => a.ownerVerified && a.owner === w).map((a) => ({ account: a.account, handle: a.handle })),
    create: async ({ wallet: w, handle, ip }) => {
      if (!/^[a-z0-9]{2,15}$/.test(handle)) return { error: "A handle is 2 to 15 lowercase letters or digits." };
      if (byHandle(handle)) return { error: `@${handle} is taken. Try another handle.` };
      created.push({ ip });
      agents.set(`0x${handle}`, { account: `0x${handle}`, handle, owner: w, ownerVerified: true });
      return { account: `0x${handle}` };
    },
    claim: (account, w) => {
      const a = agents.get(account)!;
      if (a.ownerVerified && a.owner !== w) return { error: "That agent already belongs to another wallet." };
      a.owner = w;
      a.ownerVerified = true;
      return { ok: true };
    },
    styles: ["momentum", "sniper"],
  },
});

beforeAll(async () => {
  http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (oauth.handles(url.pathname)) return oauth.handle(req, res, url, String(req.headers["x-test-ip"] ?? "1.1.1.1"));
    let d = "";
    for await (const c of req) d += c;
    await handleMcpHttp(req, res, {
      api: "http://runtime",
      authenticate: (t) => {
        const acct = keys.get(t);
        const who = acct ? { handle: agents.get(acct)?.handle } : oauth.bearer(t);
        return who && { ...who, host: !!(who.handle && byHandle(who.handle)?.host) };
      },
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
  clock = Date.now();
  resetTown();
  oauth = newOAuth();
});

// ---------------------------------------------------------------- driving the pages like a browser

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The hidden fields of the form that has a given decision (or of the wallet form). */
function formFields(html: string, which: "wallet" | "any" = "any") {
  const forms = [...html.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)];
  const isWallet = (m: RegExpMatchArray) => m[1]!.includes('id="wallet-form"');
  const form = which === "wallet" ? forms.find(isWallet) : forms.find((m) => !isWallet(m));
  const f = new URLSearchParams();
  for (const m of (form?.[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) f.set(m[1]!, unescape(m[2]!));
  return f;
}
const messageTemplate = (html: string) => unescape(/<template id="message">([\s\S]*?)<\/template>/.exec(html)![1]!);
const listed = (html: string) => [...html.matchAll(/name="pick" value="([^"]+)"/g)].map((m) => m[1]);

const VERIFIER = "v".repeat(50);
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const post = (path: string, f: URLSearchParams, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", body: f, redirect: "manual", headers });

/** A browser sign-in (claude.ai): returns the first page and how to finish. */
async function startAuthorize(scope = "read act") {
  const reg = (await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) })).json()) as any;
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"), code_challenge_method: "S256", state: "s1", scope });
  const html = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
  return { clientId: reg.client_id as string, html };
}

/** Signs the page's message with a wallet and submits it, as the page's script does. */
async function signWith(path: string, html: string, w: Wallet, opts: { as?: string; tamper?: (m: string) => string } = {}) {
  const f = formFields(html, "wallet");
  const address = opts.as ?? w.address;
  let message = messageTemplate(html).replace("{wallet}", address);
  if (opts.tamper) message = opts.tamper(message);
  f.set("wallet", address);
  f.set("signature", w.sign(message));
  const r = await post(path, f);
  return { r, html: await r.text(), sent: f };
}

/** The second step's forms carry the wallet session; submit one with a decision. */
async function choose(path: string, html: string, decision: string, extra: Record<string, string> = {}) {
  const f = formFields(html);
  f.set("decision", decision);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return post(path, f);
}

async function exchange(clientId: string, r: Response) {
  const loc = new URL(r.headers.get("location")!);
  const t = await fetch(`${base}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: CALLBACK, code_verifier: VERIFIER, client_id: clientId }) });
  return (await t.json()) as any;
}

// ---------------------------------------------------------------- wallet sign-in

describe("wallet sign-in", () => {
  it("offers only agents the wallet provably owns, then signs the client in as the one picked", async () => {
    const { clientId, html } = await startAuthorize();
    expect(html).toContain('id="wallet"');
    const message = messageTemplate(html);
    // The message names the domain, the client, the scope, the nonce and when it expires.
    expect(message).toContain(`${new URL(base).host} wants you to sign in to the agent town with your Solana account:`);
    expect(message).toMatch(/Let Claude play your agent in the town\./);
    expect(message).toContain(`Client: ${clientId}`);
    expect(message).toContain("Scope: read act");
    expect(message).toMatch(/Nonce: [A-Za-z0-9_-]{22}\nIssued At: \S+\nExpiration Time: \S+$/);

    const step2 = await signWith("/oauth/authorize", html, A);
    expect(step2.r.status).toBe(200);
    // atlas names wallet A, but that owner was never proven, so it isn't offered.
    expect(listed(step2.html)).toEqual(["moss", "rook"]);
    expect(step2.html).not.toContain("atlas");

    const done = await choose("/oauth/authorize", step2.html, "agent", { pick: "moss" });
    expect(done.status).toBe(302);
    const tok = await exchange(clientId, done);
    expect(tok).toMatchObject({ scope: "read act", agent: "moss" });

    // And it plays: the hosted MCP acts as moss with the client's own token.
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
    await c.callTool({ name: "turn", arguments: { thought: "hello", actions: [{ type: "post", body: "signed in with a wallet" }] } });
    expect(calls.at(-1)).toMatchObject({ url: "http://runtime/v1/agents/moss/actions", auth: `Bearer ${tok.access_token}` });
    await c.close();
  });

  it("refuses a signature from another wallet", async () => {
    const { html } = await startAuthorize();
    const r = await signWith("/oauth/authorize", html, B, { as: A.address }); // B signs, claims to be A
    expect(r.html).toMatch(/signature didn(&#39;|')t check out/);
    expect(listed(r.html)).toEqual([]);
  });

  it("refuses a signed message that isn't exactly the one the page asked for", async () => {
    const { html } = await startAuthorize();
    const r = await signWith("/oauth/authorize", html, A, { tamper: (m) => m.replace("Scope: read act", "Scope: read") });
    expect(r.html).toMatch(/signature didn(&#39;|')t check out/);
  });

  it("refuses a replayed signature: one nonce, one sign-in", async () => {
    const { html } = await startAuthorize();
    const first = await signWith("/oauth/authorize", html, A);
    expect(listed(first.html)).toEqual(["moss", "rook"]);
    const again = await post("/oauth/authorize", first.sent);
    expect(await again.text()).toMatch(/expired or was already used/);
  });

  it("won't take a signature made for another sign-in", async () => {
    const one = await startAuthorize();
    const two = await startAuthorize();
    // Sign request one's message, but send it with request two's fields.
    const f = formFields(two.html, "wallet");
    const nonce = formFields(one.html, "wallet").get("nonce")!;
    f.set("nonce", nonce);
    f.set("wallet", A.address);
    f.set("signature", A.sign(messageTemplate(one.html).replace("{wallet}", A.address)));
    const r = await post("/oauth/authorize", f);
    expect(await r.text()).toMatch(/expired or was already used/);
  });

  it("won't let a wallet pick an agent it doesn't provably own", async () => {
    const { html } = await startAuthorize();
    const step2 = await signWith("/oauth/authorize", html, A);
    const r = await choose("/oauth/authorize", step2.html, "agent", { pick: "atlas" });
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });

  it("expires the wallet session", async () => {
    const { html } = await startAuthorize();
    const step2 = await signWith("/oauth/authorize", html, A);
    clock += 11 * 60_000;
    const r = await choose("/oauth/authorize", step2.html, "agent", { pick: "moss" });
    expect(r.status).not.toBe(302);
    expect(await r.text()).toMatch(/wallet sign-in expired/);
  });

  it("creates a new agent owned by the wallet, with no key, and signs in as it", async () => {
    const { clientId, html } = await startAuthorize();
    const step2 = await signWith("/oauth/authorize", html, B);
    expect(listed(step2.html)).toEqual([]); // B owns nothing yet
    expect(step2.html).toMatch(/<details open>\s*<summary>Create a new agent/);
    const taken = await choose("/oauth/authorize", step2.html, "create", { handle: "moss", persona: "", style: "sniper" });
    expect(await taken.text()).toMatch(/@moss is taken/);
    const done = await choose("/oauth/authorize", step2.html, "create", { handle: "newbie", persona: "Curious, careful.", style: "sniper" });
    expect(done.status).toBe(302);
    expect(created).toHaveLength(1);
    expect(byHandle("newbie")).toMatchObject({ owner: B.address, ownerVerified: true });
    expect(await exchange(clientId, done)).toMatchObject({ agent: "newbie" });
  });

  it("claims an old agent with its key, after which the wallet alone is enough", async () => {
    const { html } = await startAuthorize();
    const step2 = await signWith("/oauth/authorize", html, B);
    const done = await choose("/oauth/authorize", step2.html, "claim", { key: KEY_ATLAS });
    expect(done.status).toBe(302);
    expect(byHandle("atlas")).toMatchObject({ owner: B.address, ownerVerified: true });
    const next = await startAuthorize();
    expect(listed((await signWith("/oauth/authorize", next.html, B)).html)).toEqual(["atlas"]);
  });

  it("won't let a key move an agent away from the wallet that proved it owns it", async () => {
    const { html } = await startAuthorize();
    const step2 = await signWith("/oauth/authorize", html, B);
    const r = await choose("/oauth/authorize", step2.html, "claim", { key: KEY_ROOK });
    expect(await r.text()).toMatch(/already belongs to another wallet/);
    expect(byHandle("rook")).toMatchObject({ owner: A.address });
  });

  it("keeps the key and read-only as fallbacks, and has no wallet step for a read-only request", async () => {
    const full = await startAuthorize();
    expect(full.html).toContain('name="key"');
    expect(full.html).toContain('value="read"');
    const ro = await startAuthorize("read");
    expect(ro.html).not.toContain('id="wallet"');
    expect(ro.html).not.toContain('name="key"');
  });

  it("serves the page's script under a nonce CSP, and nothing else", async () => {
    const { clientId } = await startAuthorize();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"), code_challenge_method: "S256" });
    const r = await fetch(`${base}/oauth/authorize?${q}`);
    const csp = r.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    const html = await r.text();
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual([`<script nonce="${nonce}">`]);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

// ---------------------------------------------------------------- device flow

describe("device flow (RFC 8628)", () => {
  async function deviceClient() {
    const reg = (await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "agents-mcp on laptop", grant_types: [DEVICE_GRANT, "refresh_token"], token_endpoint_auth_method: "none" }) })).json()) as any;
    expect(reg.client_id).toBeTruthy();
    return reg.client_id as string;
  }
  async function start(clientId: string, ip = "2.2.2.2") {
    const r = await post("/oauth/device_authorization", new URLSearchParams({ client_id: clientId, scope: "read act" }), { "x-test-ip": ip });
    return { status: r.status, d: (await r.json()) as any };
  }
  const poll = async (clientId: string, deviceCode: string) => {
    const r = await post("/oauth/token", new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }));
    return { status: r.status, d: (await r.json()) as any };
  };
  /** The owner on the device page: type the code, then make a choice. */
  async function ownerEnters(userCode: string, ip = "3.3.3.3") {
    const r = await post("/device", new URLSearchParams({ user_code: userCode.toLowerCase().replace("-", " ") }), { "x-test-ip": ip });
    return { status: r.status, html: await r.text() };
  }

  it("is advertised in the metadata", async () => {
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(as.device_authorization_endpoint).toBe(`${base}/oauth/device_authorization`);
    expect(as.grant_types_supported).toContain(DEVICE_GRANT);
  });

  it("runs end to end: pending, slow_down, approve with a key, tokens once", async () => {
    const id = await deviceClient();
    const { d } = await start(id);
    expect(d).toMatchObject({ verification_uri: `${base}/device`, expires_in: 600, interval: 5 });
    expect(d.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(d.verification_uri_complete).toBe(`${base}/device?user_code=${d.user_code}`);

    expect((await poll(id, d.device_code)).d.error).toBe("authorization_pending");
    const fast = await poll(id, d.device_code); // no wait at all
    expect(fast.status).toBe(400);
    expect(fast.d.error).toBe("slow_down");

    // The link from the terminal fills the code in; the owner still confirms it.
    const landing = await (await fetch(d.verification_uri_complete)).text();
    expect(landing).toContain(`value="${d.user_code}"`);
    const page = await ownerEnters(d.user_code);
    expect(page.html).toContain("agents-mcp on laptop");
    expect(page.html).toContain(d.user_code);
    const f = formFields(page.html);
    f.set("decision", "key");
    f.set("key", KEY_ATLAS);
    const ok = await (await post("/device", f)).text();
    expect(ok).toMatch(/signed in as @atlas/);

    clock += 11_000; // past the (now 10 second) interval
    const t = await poll(id, d.device_code);
    expect(t.status).toBe(200);
    expect(t.d).toMatchObject({ token_type: "Bearer", scope: "read act", agent: "atlas" });
    expect(oauth.bearer(t.d.access_token)).toEqual({ handle: "atlas" });
    // The device code worked once.
    clock += 11_000;
    expect((await poll(id, d.device_code)).d.error).toBe("invalid_grant");
    // The code can't be entered again either.
    expect((await ownerEnters(d.user_code)).html).toMatch(/isn(&#39;|')t valid/);
  });

  it("signs in with a wallet on the device page too", async () => {
    const id = await deviceClient();
    const { d } = await start(id);
    const page = await ownerEnters(d.user_code);
    const step2 = await signWith("/device", page.html, A);
    expect(listed(step2.html)).toEqual(["moss", "rook"]);
    expect(await (await choose("/device", step2.html, "agent", { pick: "rook" })).text()).toMatch(/signed in as @rook/);
    clock += 6_000;
    expect((await poll(id, d.device_code)).d).toMatchObject({ agent: "rook" });
  });

  it("reports a cancel as access_denied", async () => {
    const id = await deviceClient();
    const { d } = await start(id);
    const f = formFields((await ownerEnters(d.user_code)).html);
    f.set("decision", "deny");
    expect(await (await post("/device", f)).text()).toMatch(/Cancelled/);
    clock += 6_000;
    expect((await poll(id, d.device_code)).d.error).toBe("access_denied");
  });

  it("expires after ten minutes", async () => {
    const id = await deviceClient();
    const { d } = await start(id);
    clock += 601_000;
    expect((await ownerEnters(d.user_code)).html).toMatch(/expired/);
    expect((await poll(id, d.device_code)).d.error).toBe("expired_token");
  });

  it("only gives a device code to the client that asked for it", async () => {
    const id = await deviceClient();
    const other = await deviceClient();
    const { d } = await start(id);
    expect((await poll(other, d.device_code)).d.error).toBe("invalid_grant");
  });

  it("rate limits starting sign-ins and guessing codes", async () => {
    const id = await deviceClient();
    const codes = [];
    for (let i = 0; i < 20; i++) codes.push((await start(id, `9.9.9.${i}`)).status);
    expect(codes.every((s) => s === 200)).toBe(true);
    expect((await start(id, "9.9.9.99")).status).toBe(429); // 20 an hour per client
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await ownerEnters("BBBB-BBBB", "6.6.6.6")).status;
    expect(last).toBe(429); // 30 tries an hour per address
    // Sending a decision along with a guess doesn't get around it.
    const guess = await post("/device", new URLSearchParams({ user_code: "CCCC-CCCC", decision: "read" }), { "x-test-ip": "6.6.6.6" });
    expect(guess.status).toBe(429);
  });

  it("only serves the device flow to clients registered for it", async () => {
    const browser = (await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) })).json()) as any;
    const r = await start(browser.client_id);
    expect(r.d.error).toBe("unauthorized_client");
  });
});

// ---------------------------------------------------------------- agents-mcp login

describe("agents-mcp login", () => {
  function io(home: string, onWait: () => Promise<void>) {
    const out: string[] = [];
    const err: string[] = [];
    let opened = "";
    const i: Io = {
      out: (s) => out.push(s), err: (s) => err.push(s), secret: async () => "", fetch, env: { AGENTS_MCP_HOME: home },
      open: (u) => { opened = u; },
      sleep: async (ms) => { clock += ms; await onWait(); },
    };
    return { i, out, err, opened: () => opened };
  }

  it("signs in through the device page, saves only a sign-in (0600), and plays with it", async () => {
    const home = mkdtempSync(join(tmpdir(), "agents-mcp-"));
    let waits = 0;
    let started = "";
    const t = io(home, async () => {
      // The owner, on the first wait: opens the link the CLI opened, and signs in with wallet A.
      if (waits++ === 0) {
        started = t.opened();
        const code = new URL(started).searchParams.get("user_code")!;
        const page = await (await post("/device", new URLSearchParams({ user_code: code }))).text();
        const step2 = await signWith("/device", page, A);
        await choose("/device", step2.html, "agent", { pick: "moss" });
      }
    });
    expect(await main(["login", "--api", base], t.i)).toBe(0);
    expect(started).toMatch(new RegExp(`^${base}/device\\?user_code=`));
    expect(t.out.join("\n")).toMatch(/Signed in as @moss/);
    const file = join(home, "moss.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = loadAgent("moss", { AGENTS_MCP_HOME: home })!;
    expect(saved.apiKey).toBeUndefined();
    expect(saved.oauth).toMatchObject({ clientId: expect.stringMatching(/^mcp_/), refreshToken: expect.stringMatching(/^rt_/) });

    // serve: acts with the saved sign-in, and renews it on its own once it lapses.
    const env = { AGENTS_MCP_HOME: home };
    const s = new SignIn(saved, { env, fetch, now: () => clock });
    const server = createServer({ api: base, handle: "moss", token: (f) => s.token(f), fetch: (async (u: string, init?: RequestInit) => {
      if (String(u).endsWith("/actions")) {
        const a = oauth.bearer(String((init?.headers as Record<string, string>).authorization).slice(7));
        return Response.json(a?.handle === "moss" ? { results: [{ ok: true }] } : { error: "bad api key" }, { status: a ? 200 : 401 });
      }
      return Response.json({});
    }) as unknown as typeof fetch });
    const [ct, st] = (await import("@modelcontextprotocol/sdk/inMemory.js")).InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(ct);
    const turn = async () => JSON.parse(((await c.callTool({ name: "turn", arguments: { thought: "t", actions: [{ type: "post", body: "x" }] } })) as any).content[0].text);
    expect(await turn()).toEqual({ results: [{ ok: true }] });
    clock += 2 * 60 * 60_000;
    expect(await turn()).toEqual({ results: [{ ok: true }] });
    const renewed = JSON.parse(readFileSync(file, "utf8"));
    expect(renewed.oauth.refreshToken).not.toBe(saved.oauth!.refreshToken); // the rotated token was saved
    await c.close();
  });

  it("lets two processes serving one agent share a sign-in without tripping reuse detection", async () => {
    const home = mkdtempSync(join(tmpdir(), "agents-mcp-"));
    const env = { AGENTS_MCP_HOME: home };
    let waits = 0;
    const t = io(home, async () => {
      if (waits++ === 0) {
        const f = formFields((await (await post("/device", new URLSearchParams({ user_code: new URL(t.opened()).searchParams.get("user_code")! }))).text()));
        f.set("decision", "key");
        f.set("key", KEY_ATLAS);
        await post("/device", f);
      }
    });
    expect(await main(["login", "--api", base], t.i)).toBe(0);
    const saved = loadAgent("atlas", env)!;
    const one = new SignIn(saved, { env, fetch, now: () => clock });
    const two = new SignIn(saved, { env, fetch, now: () => clock });
    clock += 2 * 60 * 60_000; // both hold an expired access token
    const a = await one.token();
    clock += 5 * 60_000; // well past the retry grace
    const b = await two.token(); // reads what one saved instead of spending the old refresh token
    expect(b).toBe(a);
    expect(oauth.verify(a)).not.toBeNull();
  });

  it("says so when the owner cancels", async () => {
    const home = mkdtempSync(join(tmpdir(), "agents-mcp-"));
    let waits = 0;
    const t = io(home, async () => {
      if (waits++ === 0) {
        const f = formFields((await (await post("/device", new URLSearchParams({ user_code: new URL(t.opened()).searchParams.get("user_code")! }))).text()));
        f.set("decision", "deny");
        await post("/device", f);
      }
    });
    expect(await main(["login", "--api", base], t.i)).toBe(1);
    expect(t.err.join("\n")).toMatch(/cancelled/);
  });
});

// ---------------------------------------------------------------- host

describe("host agents over the hosted MCP", () => {
  it("never offers a host the trading tools, and its turn can't trade", async () => {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY_HOST}` } } }));
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const t of ["buy", "sell", "predict", "pledge"]) expect(names).not.toContain(t);
    expect(names).toContain("post");
    const before = calls.length;
    const r = JSON.parse(((await c.callTool({ name: "turn", arguments: { thought: "x", actions: [{ type: "buy", token: "t", ethIn: "1" }] } })) as any).content[0].text);
    expect(r.error).toMatch(/host never touches the market/);
    expect(calls.length).toBe(before);
    await c.close();
  });

  it("still offers trading to everyone else", async () => {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY_ATLAS}` } } }));
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["buy", "sell", "predict", "pledge"]));
    await c.close();
  });
});
