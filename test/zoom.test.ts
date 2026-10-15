import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMock } from "./mockZoom.js";
import { loadCredentials } from "../src/config.js";
import { ZoomClient, ZoomError } from "../src/zoomClient.js";
import * as ops from "../src/ops.js";
import type { StoredTokens, TokenStore } from "../src/zoomClient.js";

const M = "81234567890";
const writes = (calls: { method: string }[]) => calls.filter((c) => c.method !== "GET" && !(c as any).path.startsWith("/oauth"));

test("config: env wins, file fills gaps, error never contains secrets", () => {
  const c = loadCredentials({ ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b" } as any, () => JSON.stringify({ ZOOM_CLIENT_SECRET: "s3", ZOOM_CLIENT_ID: "ignored" }));
  assert.deepEqual(c, { accountId: "a", clientId: "b", clientSecret: "s3" });
  assert.equal(loadCredentials({ ZOOM_CLIENT_ID: "b", ZOOM_CLIENT_SECRET: "s" } as any, () => "{}").accountId, undefined);
  assert.throws(() => loadCredentials({ ZOOM_CLIENT_SECRET: "topsecret" } as any, () => { throw new Error("nofile"); }), (e: Error) => /ZOOM_CLIENT_ID/.test(e.message) && !e.message.includes("topsecret"));
});

test("token is cached and refreshed ~5 min before expiry", async () => {
  const m = makeMock({ tokenExpiresIn: 3600 });
  const c = m.client();
  await c.getToken();
  await c.getToken();
  assert.equal(m.tokenCount(), 1);
  m.advance(3600_000 - 6 * 60_000);
  await c.getToken();
  assert.equal(m.tokenCount(), 1);
  m.advance(2 * 60_000); // now inside the 5-minute margin
  await c.getToken();
  assert.equal(m.tokenCount(), 2);
});

test("bad credentials give a clear error without leaking the secret", async () => {
  const m = makeMock();
  const bad = new ZoomClient({ accountId: "acct", clientId: "cid", clientSecret: "WRONG" }, { fetch: m.fetch });
  await assert.rejects(bad.getToken(), (e: any) => e instanceof ZoomError && e.status === 401 && !e.message.includes("WRONG"));
});

test("whoami and list_meetings (topic filter + occurrences)", async () => {
  const m = makeMock();
  const c = m.client();
  assert.equal((await ops.whoami(c)).user.email, "king@example.com");
  const r = await ops.listMeetings(c, { topic_contains: "catalyst", include_occurrences: true, max_occurrences: 5 });
  assert.equal(r.count, 1);
  assert.deepEqual(r.meetings[0].occurrences.map((o: any) => o.occurrence_id), ["1002", "1003", "1005"]);
});

test("add_registrant dry_run makes no write", async () => {
  const m = makeMock();
  const r: any = await ops.addRegistrant(m.client(), { meeting_id: M, email: "a@x.com", first_name: "A", last_name: "B", occurrence_ids: ["1002"], dry_run: true });
  assert.equal(r.dry_run, true);
  assert.equal(r.would_send.query.occurrence_ids, "1002");
  assert.equal(writes(m.calls).length, 0);
  assert.equal(m.regs.length, 0);
});

test("add_registrant sends occurrence_ids, returns join_url, verifies by re-read", async () => {
  const m = makeMock();
  const r: any = await ops.addRegistrant(m.client(), { meeting_id: M, email: "a@x.com", first_name: "A", last_name: "B", occurrence_ids: ["1002", "1003"] });
  const post = m.calls.find((c) => c.method === "POST" && c.path.endsWith("/registrants"))!;
  assert.equal(post.query.occurrence_ids, "1002,1003");
  assert.deepEqual(post.body, { email: "a@x.com", first_name: "A", last_name: "B" });
  assert.match(r.join_url, /zoom\.us\/w\//);
  assert.equal(r.verification.verified, true);
  assert.equal(r.verification.re_read.length, 2);
  assert.ok(r.verification.re_read.every((x: any) => x.name_matches));
});

test("cancel_registrant uses occurrence_id (singular) and verifies", async () => {
  const m = makeMock();
  const c = m.client();
  await ops.addRegistrant(c, { meeting_id: M, email: "a@x.com", first_name: "A", occurrence_ids: ["1002", "1003"] });
  m.calls.length = 0;
  const r: any = await ops.cancelRegistrant(c, { meeting_id: M, email: "A@X.com", occurrence_id: "1002" });
  const put = m.calls.find((x) => x.method === "PUT")!;
  assert.equal(put.query.occurrence_id, "1002");
  assert.equal(put.query.occurrence_ids, undefined);
  assert.deepEqual(put.body, { action: "cancel", registrants: [{ id: "reg1", email: "a@x.com" }] });
  assert.equal(r.verification.verified, true);
  // still registered for 1003
  const other = await ops.listRegistrants(c, { meeting_id: M, occurrence_id: "1003" });
  assert.equal(other.returned, 1);
});

test("cancel_registrant flags a 204 that changed nothing", async () => {
  const m = makeMock({ cancelIsNoop: true });
  const c = m.client();
  await ops.addRegistrant(c, { meeting_id: M, email: "a@x.com", first_name: "A" });
  const r: any = await ops.cancelRegistrant(c, { meeting_id: M, email: "a@x.com" });
  assert.equal(r.http_status, 204);
  assert.equal(r.verification.verified, false);
  assert.match(r.verification.warning, /still approved/);
});

test("cancel_registrant refuses when person not found; only touches listed person", async () => {
  const m = makeMock();
  const c = m.client();
  await ops.addRegistrant(c, { meeting_id: M, email: "a@x.com", first_name: "A" });
  await ops.addRegistrant(c, { meeting_id: M, email: "b@x.com", first_name: "B" });
  const none: any = await ops.cancelRegistrant(c, { meeting_id: M, email: "zzz@x.com" });
  assert.equal(none.performed, false);
  await ops.cancelRegistrant(c, { meeting_id: M, email: "a@x.com" });
  const put = m.calls.filter((x) => x.method === "PUT");
  assert.equal(put.length, 1);
  assert.equal(put[0].body.registrants.length, 1);
  assert.equal(m.regs.find((r) => r.email === "b@x.com")!.status, "approved");
});

test("cancel dry_run makes no write", async () => {
  const m = makeMock();
  const c = m.client();
  await ops.addRegistrant(c, { meeting_id: M, email: "a@x.com", first_name: "A" });
  m.calls.length = 0;
  const r: any = await ops.cancelRegistrant(c, { meeting_id: M, email: "a@x.com", dry_run: true });
  assert.equal(r.dry_run, true);
  assert.equal(writes(m.calls).length, 0);
});

test("re_register changes the name via cancel then add, and verifies", async () => {
  const m = makeMock();
  const c = m.client();
  await ops.addRegistrant(c, { meeting_id: M, email: "a@x.com", first_name: "Joe", last_name: "Smith" });
  const dry: any = await ops.reRegister(c, { meeting_id: M, email: "a@x.com", first_name: "VIP - Joe", last_name: "Smith", dry_run: true });
  assert.equal(dry.dry_run, true);
  assert.equal(m.regs[0].status, "approved");
  const r: any = await ops.reRegister(c, { meeting_id: M, email: "a@x.com", first_name: "VIP - Joe", last_name: "Smith" });
  assert.equal(r.cancel.verification.verified, true);
  assert.equal(r.add.verification.verified, true);
  assert.ok(r.add.verification.re_read[0].name_matches);
  assert.ok(r.join_url);
  const active = m.regs.filter((x) => x.status === "approved");
  assert.equal(active.length, 1);
  assert.equal(active[0].first_name, "VIP - Joe");
});

test("re_register aborts without adding when cancel does not verify", async () => {
  const m = makeMock({ cancelIsNoop: true });
  const c = m.client();
  await ops.addRegistrant(c, { meeting_id: M, email: "a@x.com", first_name: "Joe" });
  m.calls.length = 0;
  const r: any = await ops.reRegister(c, { meeting_id: M, email: "a@x.com", first_name: "VIP - Joe" });
  assert.equal(r.aborted, true);
  assert.equal(m.calls.filter((x) => x.method === "POST").length, 0);
});

test("add_to_next_meetings picks the next N upcoming, skipping past and deleted", async () => {
  const m = makeMock();
  const c = m.client();
  const dry: any = await ops.addToNextMeetings(c, { meeting_id: M, email: "a@x.com", first_name: "A", count: 2, dry_run: true });
  assert.deepEqual(dry.occurrences_selected.map((o: any) => o.occurrence_id), ["1002", "1003"]);
  assert.equal(writes(m.calls).length, 0);
  const r: any = await ops.addToNextMeetings(c, { meeting_id: M, email: "a@x.com", first_name: "A", count: 5 });
  assert.deepEqual(r.occurrences_selected.map((o: any) => o.occurrence_id), ["1002", "1003", "1005"]);
  assert.match(r.notes[0], /Only 3/);
  assert.equal(r.verification.verified, true);
  assert.ok(r.join_url);
});

test("Zoom errors surface with status and body", async () => {
  const m = makeMock();
  await assert.rejects(ops.getMeeting(m.client(), { meeting_id: "99999999" }), (e: any) => e instanceof ZoomError && e.status === 404);
});

function memStore(initial?: StoredTokens): TokenStore & { cur?: StoredTokens } {
  const s: any = { cur: initial, read: () => s.cur, write: (t: StoredTokens) => (s.cur = t) };
  return s;
}

test("user OAuth: refreshes with the stored refresh token and persists the rotated one", async () => {
  const m = makeMock();
  const store = memStore({ access_token: "old", refresh_token: "ref0", expires_at: 0 });
  const c = new ZoomClient({ clientId: "cid", clientSecret: "csecret" }, { fetch: m.fetch, now: () => 1_000_000, tokenStore: store });
  const w: any = await ops.whoami(c);
  assert.equal(w.user.email, "king@example.com");
  const tokenCall = m.calls.find((x) => x.path === "/oauth/token")!;
  assert.equal(tokenCall.query.grant_type, "refresh_token");
  assert.equal(tokenCall.query.account_id, undefined);
  assert.match(store.cur!.refresh_token, /^ref[1-9]/);
  assert.notEqual(store.cur!.refresh_token, "ref0");
  // second client (another Claude process) reuses the still-valid stored token instead of burning the refresh token
  const c2 = new ZoomClient({ clientId: "cid", clientSecret: "csecret" }, { fetch: m.fetch, now: () => 1_000_000, tokenStore: store });
  await c2.getToken();
  assert.equal(m.calls.filter((x) => x.path === "/oauth/token").length, 1);
});

test("user OAuth: clear error when never authorized", async () => {
  const m = makeMock();
  const c = new ZoomClient({ clientId: "cid", clientSecret: "csecret" }, { fetch: m.fetch, tokenStore: memStore() });
  await assert.rejects(c.getToken(), (e: any) => /npm run authorize/.test(e.message));
});
