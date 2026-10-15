import type { ZoomCredentials } from "./config.js";

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

  constructor(
    private credsSource: ZoomCredentials | (() => ZoomCredentials),
    opts: ZoomClientOptions = {},
  ) {
    this.f = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.apiBase = opts.apiBase ?? "https://api.zoom.us/v2";
    this.tokenUrl = opts.tokenUrl ?? "https://zoom.us/oauth/token";
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
    const url = `${this.tokenUrl}?grant_type=account_credentials&account_id=${encodeURIComponent(creds.accountId)}`;
    const res = await this.f(url, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const body = await parseBody(res);
    if (!res.ok || !(body as any)?.access_token) {
      throw new ZoomError(`Zoom token request failed (HTTP ${res.status}). Check account id / client id / secret and that the app is activated.`, res.status, body);
    }
    const b = body as { access_token: string; expires_in?: number };
    this.token = { value: b.access_token, expiresAt: this.now() + (b.expires_in ?? 3600) * 1000 };
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
