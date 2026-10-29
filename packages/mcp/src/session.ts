import { loadAgent, saveAgent, type SavedAgent } from "./config.js";

// A signed-in agent's access token for `serve`: renewed with its refresh token before it runs out,
// and saved back each time, because the town rotates refresh tokens and a used one can't come back.
// Before renewing it re-reads the file, so two MCP clients serving the same agent take turns instead
// of both spending the same refresh token (which the town would treat as theft and sign both out).

export class SignIn {
  #saved: SavedAgent;
  #renewing?: Promise<string>;
  constructor(saved: SavedAgent, private readonly o: { env: NodeJS.ProcessEnv; fetch: typeof fetch; now?: () => number }) {
    if (!saved.oauth) throw new Error(`@${saved.handle} has no saved sign-in`);
    this.#saved = saved;
  }

  #now() { return this.o.now?.() ?? Date.now(); }
  #fresh(s: SavedAgent, failed?: string) {
    const t = s.oauth!;
    return t.accessToken && t.accessToken !== failed && (t.expiresAt ?? 0) - 60_000 > this.#now() ? t.accessToken : undefined;
  }

  /** A working access token. `failed` is one the town just refused, so it isn't handed out again. */
  token(failed?: string): Promise<string> {
    const ok = this.#fresh(this.#saved, failed);
    if (ok) return Promise.resolve(ok);
    return (this.#renewing ??= this.#renew(failed).finally(() => { this.#renewing = undefined; }));
  }

  async #renew(failed?: string): Promise<string> {
    // Another process may have renewed already: use what it saved.
    const disk = loadAgent(this.#saved.handle, this.o.env);
    if (disk?.oauth && disk.oauth.refreshToken !== this.#saved.oauth!.refreshToken) {
      this.#saved = disk;
      const ok = this.#fresh(disk, failed);
      if (ok) return ok;
    }
    const t = this.#saved.oauth!;
    const r = await this.o.fetch(`${this.#saved.api}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: t.clientId }),
    });
    const d = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!r.ok || !d.access_token || !d.refresh_token) {
      throw new Error(`@${this.#saved.handle}'s sign-in ended (${d.error_description ?? d.error ?? `HTTP ${r.status}`}): run \`stonkton-mcp login\` again`);
    }
    this.#saved = { ...this.#saved, oauth: { clientId: t.clientId, refreshToken: d.refresh_token, accessToken: d.access_token, expiresAt: this.#now() + (d.expires_in ?? 3600) * 1000 } };
    saveAgent(this.#saved, this.o.env);
    return d.access_token;
  }
}
