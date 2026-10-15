import { ZoomClient, type FetchLike } from "../src/zoomClient.js";

export interface MockReg {
  id: string;
  email: string;
  first_name: string;
  last_name?: string;
  status: "approved" | "pending" | "denied";
  occurrence_ids: string[]; // empty = all occurrences
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: any;
}

/** In-memory fake of the Zoom endpoints this server uses. */
export function makeMock(opts: { cancelIsNoop?: boolean; tokenExpiresIn?: number } = {}) {
  const calls: Call[] = [];
  let tokenCount = 0;
  let clock = 1_000_000;
  const regs: MockReg[] = [];
  const validRefresh = new Set<string>(["ref0"]);
  let nextId = 1;
  const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
  const meeting = {
    id: 81234567890,
    topic: "Catalyst Odd Cohort",
    type: 8,
    start_time: future(1),
    settings: { approval_type: 0, registration_type: 2 },
    occurrences: [
      { occurrence_id: "1001", start_time: new Date(Date.now() - 86400_000).toISOString(), status: "available" },
      { occurrence_id: "1002", start_time: future(2), status: "available" },
      { occurrence_id: "1003", start_time: future(9), status: "available" },
      { occurrence_id: "1004", start_time: future(16), status: "deleted" },
      { occurrence_id: "1005", start_time: future(23), status: "available" },
    ],
  };

  const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const query = Object.fromEntries(u.searchParams.entries());
    const path = u.pathname.replace(/^\/v2/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (u.hostname === "zoom.us" && path === "/oauth/token") {
      tokenCount++;
      calls.push({ method, path, query });
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      if (auth !== "Basic " + Buffer.from("cid:csecret").toString("base64")) return json(401, { reason: "Invalid client_id or client_secret" });
      if (query.grant_type === "refresh_token") {
        if (!validRefresh.has(query.refresh_token)) return json(400, { reason: "Invalid refresh token" });
        validRefresh.delete(query.refresh_token);
        const nr = `ref${tokenCount}`;
        validRefresh.add(nr);
        return json(200, { access_token: `tok${tokenCount}`, refresh_token: nr, expires_in: opts.tokenExpiresIn ?? 3600 });
      }
      if (query.grant_type !== "account_credentials" || query.account_id !== "acct") return json(400, { reason: "bad request" });
      return json(200, { access_token: `tok${tokenCount}`, token_type: "bearer", expires_in: opts.tokenExpiresIn ?? 3600 });
    }
    calls.push({ method, path, query, body });
    const authz = (init?.headers as Record<string, string>)?.Authorization ?? "";
    if (!authz.startsWith("Bearer tok")) return json(401, { message: "Invalid access token" });

    if (method === "GET" && path === "/users/me") return json(200, { id: "u1", email: "king@example.com", display_name: "King", type: 2, account_id: "acct" });
    if (method === "GET" && path === "/users/me/meetings")
      return json(200, { meetings: [{ id: meeting.id, topic: meeting.topic, type: 8 }, { id: 5551234567, topic: "Other", type: 2 }], next_page_token: "" });
    if (method === "GET" && path === `/meetings/${meeting.id}`) return json(200, meeting);

    if (path === `/meetings/${meeting.id}/registrants` && method === "GET") {
      const want = query.status ?? "approved";
      const occ = query.occurrence_id;
      const list = regs
        .filter((r) => r.status === want && (!occ || r.occurrence_ids.length === 0 || r.occurrence_ids.includes(occ)))
        .map((r) => ({ id: r.id, email: r.email, first_name: r.first_name, last_name: r.last_name, status: r.status, join_url: `https://zoom.us/w/${meeting.id}?tk=${r.id}` }));
      return json(200, { page_size: 300, total_records: list.length, next_page_token: "", registrants: list });
    }
    if (path === `/meetings/${meeting.id}/registrants` && method === "POST") {
      const occ = query.occurrence_ids ? query.occurrence_ids.split(",") : [];
      let r = regs.find((x) => x.email === body.email && x.status === "approved");
      if (r) {
        // behaviour for an existing email is ASSUMED by this mock: same registrant, name unchanged
        r.occurrence_ids = [...new Set([...r.occurrence_ids, ...occ])];
      } else {
        r = { id: `reg${nextId++}`, email: body.email, first_name: body.first_name, last_name: body.last_name, status: "approved", occurrence_ids: occ };
        regs.push(r);
      }
      return json(201, {
        id: meeting.id,
        registrant_id: r.id,
        topic: meeting.topic,
        join_url: `https://zoom.us/w/${meeting.id}?tk=${r.id}`,
        occurrences: occ.map((o) => ({ occurrence_id: o })),
      });
    }
    if (path === `/meetings/${meeting.id}/registrants/status` && method === "PUT") {
      if (!opts.cancelIsNoop) {
        for (const t of body.registrants) {
          const r = regs.find((x) => x.id === t.id);
          if (!r) continue;
          if (query.occurrence_id && r.occurrence_ids.length) {
            r.occurrence_ids = r.occurrence_ids.filter((o) => o !== query.occurrence_id);
            if (r.occurrence_ids.length === 0) r.status = "denied";
          } else r.status = "denied";
        }
      }
      return json(204);
    }
    return json(404, { code: 3001, message: `unmocked ${method} ${path}` });
  };

  const client = (o: { now?: () => number } = {}) =>
    new ZoomClient({ accountId: "acct", clientId: "cid", clientSecret: "csecret" }, { fetch, now: o.now ?? (() => clock), sleep: async () => {} });

  return { fetch, calls, regs, meeting, client, advance: (ms: number) => (clock += ms), tokenCount: () => tokenCount };
}
