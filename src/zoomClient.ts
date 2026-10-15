import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultTokensPath, type ZoomCredentials } from "./config.js";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

export interface TokenStore {
  read(): StoredTokens | undefined;
  write(t: StoredTokens): void;
}

export class FileTokenStore implements TokenStore {
  constructor(private path: string = defaultTokensPath()) {}
  read(): StoredTokens | undefined {
    try {
      const t = JSON.parse(readFileSync(this.path, "utf8"));
      return t?.refresh_token ? t : undefined;
    } catch {
      return undefined;
    }
  }
  write(t: StoredTokens): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class ZoomError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = "ZoomError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ZoomClientOptions {
  fetch?: FetchLike;
  now?: () => number;
  apiBase?: string;
  tokenUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  tokenStore?: TokenStore;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Minimal Zoom REST client with Server-to-Server OAuth (grant_type=account_credentials) token caching. */
export class ZoomClient {
  private token?: { value: string; expiresAt: number };
  private inflight?: Promise<string>;
  private f: FetchLike;
  private now: () => number;
  private apiBase: string;
  private tokenUrl: string;
  private sleep: (ms: number) => Promise<void>;
  private store: TokenStore;

  constructor(
    private credsSource: ZoomCredentials | (() => ZoomCredentials),
    opts: ZoomClientOptions = {},
  ) {
    this.f = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.apiBase = opts.apiBase ?? "https://api.zoom.us/v2";
    this.tokenUrl = opts.tokenUrl ?? "https://zoom.us/oauth/token";
    this.store = opts.tokenStore ?? new FileTokenStore();
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async getToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - REFRESH_MARGIN_MS) return this.token.value;
    this.inflight ??= this.fetchToken().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const creds = typeof this.credsSource === "function" ? this.credsSource() : this.credsSource;
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    let url: string;
    if (creds.accountId) {
      // Server-to-Server OAuth
      url = `${this.tokenUrl}?grant_type=account_credentials&account_id=${encodeURIComponent(creds.accountId)}`;
    } else {
      // User OAuth: reuse a still-valid token (another Claude process may have refreshed it), else rotate the refresh token.
      const stored = this.store.read();
      if (!stored) {
        throw new ZoomError("Not authorized yet. Run `npm run authorize` in C:\Users\KING\Desktop\zoom-mcp once and click Allow in the browser (see README).", 401, undefined);
      }
      if (this.now() < stored.expires_at - REFRESH_MARGIN_MS) {
        this.token = { value: stored.access_token, expiresAt: stored.expires_at };
        return stored.access_token;
      }
      url = `${this.tokenUrl}?grant_type=refresh_token&refresh_token=${encodeURIComponent(stored.refresh_token)}`;
    }
    const res = await this.f(url, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const body = await parseBody(res);
    if (!res.ok || !(body as any)?.access_token) {
      throw new ZoomError(
        `Zoom token request failed (HTTP ${res.status}). ` +
          (creds.accountId ? "Check account id / client id / secret and that the app is activated." : "Run `npm run authorize` again (the refresh token may have expired or been replaced)."),
        res.status,
        body,
      );
    }
    const b = body as { access_token: string; refresh_token?: string; expires_in?: number };
    const expiresAt = this.now() + (b.expires_in ?? 3600) * 1000;
    if (!creds.accountId && b.refresh_token) this.store.write({ access_token: b.access_token, refresh_token: b.refresh_token, expires_at: expiresAt });
    this.token = { value: b.access_token, expiresAt };
    return b.access_token;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<{ status: number; data: T }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${this.apiBase}${path}${qs.size ? `?${qs}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const res = await this.f(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        this.token = undefined; // token may have been revoked; refresh once
        continue;
      }
      if (res.status === 429 && attempt < 2) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000);
        continue;
      }
      const data = await parseBody(res);
      if (!res.ok) {
        const msg = (data as any)?.message ?? res.statusText;
        throw new ZoomError(`Zoom ${method} ${path} failed: HTTP ${res.status} ${msg}`, res.status, data);
      }
      return { status: res.status, data: data as T };
    }
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
