import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PRESETS } from "@agents/core";
import { PublicKey } from "@solana/web3.js";
import { TownOAuth } from "agents-mcp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifySignature } from "./enroll.js";
import { claimAgent, clearClaim, migrateOwnerProof, proveOwner, resetApiKey, walletAgents } from "./ownership.js";
import type { Agent } from "./world.js";

// A leaked key must not turn into a permanent takeover: whoever holds it can claim an unproven agent
// for their own wallet, so the operator's key reset undoes that claim along with the old keys and
// sign-ins. Owners proven on-chain or by creating the agent with their wallet keep it through a reset.

const keyHash = (k: string) => createHash("sha256").update(k).digest("hex");
const mk = (handle: string, owner: string, extra: Partial<Agent> = {}): Agent => ({ account: `0x${handle}`, owner, handle, name: handle, persona: "", modelId: "m", plan: PRESETS.momentum, awake: true, external: true, createdAt: 0, ...extra });

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = new PublicKey(publicKey.export({ format: "der", type: "spki" }).subarray(12)).toBase58();
  return { address, sign: (m: string) => sign(null, Buffer.from(m, "utf8"), privateKey).toString("base64") };
}
const OWNER = wallet();
const THIEF = wallet();

describe("ownership rules", () => {
  it("undoes a claim made with a stolen key when the key is reset, so the owner can claim again", () => {
    const atlas = mk("atlas", "0xwhatever-the-owner-typed");
    const keys = new Map([[keyHash("ak_old"), atlas.account]]);
    // The thief has the key, so the sign-in page lets them claim the unproven agent for their wallet.
    expect(claimAgent(atlas, THIEF.address)).toEqual({ ok: true });
    expect(walletAgents([atlas], THIEF.address)).toEqual([atlas]);
    expect(claimAgent(atlas, OWNER.address)).toEqual({ error: "That agent already belongs to another wallet." });

    const ended: string[] = [];
    const r = resetApiKey(atlas, keys, (acct) => { ended.push(acct); return 3; });
    expect(r).toMatchObject({ signInsEnded: 3, claimCleared: true });
    expect(ended).toEqual([atlas.account]);
    expect(keys.has(keyHash("ak_old"))).toBe(false);
    expect(keys.get(keyHash(r.apiKey))).toBe(atlas.account);
    // The thief's wallet no longer owns it, and the owner string is what it was before the claim.
    expect(walletAgents([atlas], THIEF.address)).toEqual([]);
    expect(atlas).toMatchObject({ owner: "0xwhatever-the-owner-typed" });
    expect(atlas.ownerVerified).toBeUndefined();
    expect(atlas.ownerProof).toBeUndefined();
    // The owner, with the new key, claims it for their wallet.
    expect(claimAgent(atlas, OWNER.address)).toEqual({ ok: true });
    expect(walletAgents([atlas], OWNER.address)).toEqual([atlas]);
  });

  it("never moves an owner proven on-chain or by creating the agent", () => {
    const chain = mk("moss", OWNER.address);
    proveOwner(chain, "chain");
    const created = mk("newbie", OWNER.address);
    proveOwner(created, "created");
    for (const a of [chain, created]) {
      const keys = new Map([[keyHash("ak_x"), a.account]]);
      expect(resetApiKey(a, keys, () => 0).claimCleared).toBe(false);
      expect(a).toMatchObject({ owner: OWNER.address, ownerVerified: true });
      expect(walletAgents([a], OWNER.address)).toEqual([a]);
      expect(clearClaim(a)).toBe(false);
    }
    expect(chain.ownerProof).toBe("chain");
    expect(created.ownerProof).toBe("created");
  });

  it("keeps the stronger proof when a wallet claims an agent it already owns", () => {
    const a = mk("moss", OWNER.address);
    proveOwner(a, "chain");
    expect(claimAgent(a, OWNER.address)).toEqual({ ok: true });
    expect(a.ownerProof).toBe("chain");
  });

  it("migrates saved proven owners from before ownerProof as chain-proven", () => {
    const old = mk("moss", OWNER.address, { ownerVerified: true });
    const unproven = mk("atlas", "0x1");
    expect(migrateOwnerProof([old, unproven])).toBe(1);
    expect(old.ownerProof).toBe("chain");
    expect(unproven.ownerProof).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the same story through the sign-in page

const KEY = `ak_${"d4".repeat(24)}`;
let agents: Map<string, Agent>;
let keys: Map<string, string>;
let oauth: TownOAuth;
let http: Server;
let base: string;

const newOAuth = () => new TownOAuth({
  issuer: base,
  accountForKey: (k) => keys.get(keyHash(k)),
  handleOf: (acct) => agents.get(acct)?.handle,
  // The runtime's own hooks (main.ts), on this little town.
  wallet: {
    verify: (w, m, s) => { try { return verifySignature(new PublicKey(w).toBytes(), m, s); } catch { return false; } },
    agents: (w) => walletAgents(agents.values(), w).map((a) => ({ account: a.account, handle: a.handle })),
    create: () => ({ error: "not in this test" }),
    claim: (acct, w) => claimAgent(agents.get(acct)!, w),
    styles: ["momentum"],
  },
});

beforeAll(async () => {
  http = createServer((req, res) => void oauth.handle(req, res, new URL(req.url ?? "/", base), "1.1.1.1"));
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => http.close(() => ok())));
beforeEach(() => {
  agents = new Map([["0xatlas", mk("atlas", "0xtyped")]]);
  keys = new Map([[keyHash(KEY), "0xatlas"]]);
  oauth = newOAuth();
});

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function fields(html: string, wallet: boolean) {
  const form = [...html.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)].find((m) => m[1]!.includes('id="wallet-form"') === wallet)!;
  const f = new URLSearchParams();
  for (const m of form[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) f.set(m[1]!, unescape(m[2]!));
  return f;
}
const VERIFIER = "w".repeat(50);
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** Signs in with a wallet and returns the second step's page. */
async function walletSignIn(w: { address: string; sign: (m: string) => string }) {
  const reg = (await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) })).json()) as { client_id: string };
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"), code_challenge_method: "S256" });
  const first = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
  const f = fields(first, true);
  f.set("wallet", w.address);
  f.set("signature", w.sign(unescape(/<template id="message">([\s\S]*?)<\/template>/.exec(first)![1]!).replace("{wallet}", w.address)));
  const html = await (await fetch(`${base}/oauth/authorize`, { method: "POST", body: f })).text();
  return { clientId: reg.client_id, html, listed: [...html.matchAll(/name="pick" value="([^"]+)"/g)].map((m) => m[1]) };
}
async function claimOn(page: { clientId: string; html: string }, key: string) {
  const f = fields(page.html, false);
  f.set("decision", "claim");
  f.set("key", key);
  const r = await fetch(`${base}/oauth/authorize`, { method: "POST", body: f, redirect: "manual" });
  if (r.status !== 302) return { error: await r.text() };
  const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
  const t = await fetch(`${base}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: VERIFIER, client_id: page.clientId }) });
  return (await t.json()) as { access_token: string; agent?: string };
}

describe("a stolen key, through the sign-in page", () => {
  it("claims, gets reset away, and the owner claims the agent back", async () => {
    // The thief claims atlas for their wallet with the stolen key and signs in as it.
    const thief = await claimOn(await walletSignIn(THIEF), KEY);
    expect(thief).toMatchObject({ agent: "atlas" });
    expect((await walletSignIn(THIEF)).listed).toEqual(["atlas"]);
    const ownerTry = await claimOn(await walletSignIn(OWNER), KEY);
    expect("error" in ownerTry && ownerTry.error).toMatch(/already belongs to another wallet/);

    // The owner reports it; the operator resets the key (POST /v1/admin/agents/atlas/key).
    const r = resetApiKey(agents.get("0xatlas")!, keys, (acct) => oauth.revokeAccount(acct));
    expect(r.claimCleared).toBe(true);
    expect(r.signInsEnded).toBeGreaterThan(0);

    // The thief's sign-in is over, their wallet no longer lists atlas, and the old key claims nothing.
    expect(oauth.verify((thief as { access_token: string }).access_token)).toBeNull();
    const back = await walletSignIn(THIEF);
    expect(back.listed).toEqual([]);
    expect("error" in (await claimOn(back, KEY))).toBe(true);

    // The owner claims it with the new key, and from then on their wallet is enough.
    expect(await claimOn(await walletSignIn(OWNER), r.apiKey)).toMatchObject({ agent: "atlas" });
    expect((await walletSignIn(OWNER)).listed).toEqual(["atlas"]);
  });
});
