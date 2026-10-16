import { test } from "node:test";
import assert from "node:assert/strict";
import { callAttendance } from "../src/attendance.js";

// Fake Zoom client: only `request` is used by callAttendance.
function fake(opts: { live?: boolean; instances?: any[]; participants?: Record<string, any[]>; registrants?: any[] }) {
  const calls: string[] = [];
  const client: any = {
    async request(method: string, path: string, o: any = {}) {
      calls.push(`${method} ${path}`);
      if (path === "/meetings/111222333") {
        return { status: 200, data: { topic: "Test call", duration: 90, occurrences: [{ occurrence_id: "OCC1", start_time: "2026-10-16T16:00:00Z", duration: 90 }] } };
      }
      if (path === "/users/me/meetings") return { status: 200, data: { meetings: opts.live ? [{ id: 111222333 }] : [] } };
      if (path === "/past_meetings/111222333/instances") return { status: 200, data: { meetings: opts.instances ?? [] } };
      const m = path.match(/^\/past_meetings\/(.+)\/participants$/);
      if (m) {
        const uuid = decodeURIComponent(decodeURIComponent(m[1]));
        return { status: 200, data: { participants: opts.participants?.[uuid] ?? [] } };
      }
      if (path === "/meetings/111222333/registrants") return { status: 200, data: { registrants: opts.registrants ?? [], total_records: (opts.registrants ?? []).length } };
      throw new Error("unexpected " + path);
    },
  };
  return { client, calls };
}

const reg = [
  { email: "a@x.com", first_name: "VIP - Ann", last_name: "A." },
  { email: "b@x.com", first_name: "Bob", last_name: "B." },
  { email: "c@x.com", first_name: "Cy", last_name: "C." },
  { email: "d@x.com", first_name: "Dan", last_name: "D." },
  { email: "team@joinotherside.com", first_name: "Samson", last_name: "O." },
  { email: "ed@gmail.com", first_name: "Edward", last_name: "Bertsch - Otherside Team" },
];

test("live call: report waits", async () => {
  const { client } = fake({ live: true });
  const r: any = await callAttendance(client, { meeting_id: "111222333", date: "2026-10-16" }, () => Date.parse("2026-10-16T17:00:00Z"));
  assert.equal(r.status, "live");
});

test("before the call starts", async () => {
  const { client } = fake({});
  const r: any = await callAttendance(client, { meeting_id: "111222333", date: "2026-10-16" }, () => Date.parse("2026-10-16T10:00:00Z"));
  assert.equal(r.status, "not_started");
});

test("no past session yet", async () => {
  const { client } = fake({ instances: [] });
  const r: any = await callAttendance(client, { meeting_id: "111222333", date: "2026-10-16" }, () => Date.parse("2026-10-16T19:00:00Z"));
  assert.equal(r.status, "no_session_found");
});

test("attended / missed / brief / name fallback / team excluded / extras", async () => {
  const { client } = fake({
    instances: [
      { uuid: "/short==", start_time: "2026-10-16T15:50:00Z" }, // tiny test session
      { uuid: "REAL", start_time: "2026-10-16T15:58:00Z" },
    ],
    participants: {
      "/short==": [{ name: "Host", user_email: "team@joinotherside.com", duration: 30 }],
      REAL: [
        { name: "Ann A.", user_email: "a@x.com", duration: 3000 },
        { name: "Ann A.", user_email: "a@x.com", duration: 1200 }, // rejoin adds up
        { name: "Bob B.", user_email: "", duration: 2400 }, // email hidden -> name fallback
        { name: "Cy C.", user_email: "c@x.com", duration: 90 }, // joined briefly (<5 min)
        { name: "Stranger", user_email: "z@x.com", duration: 1800 }, // not registered
        { name: "Samson", user_email: "team@joinotherside.com", duration: 6000 },
      ],
    },
    registrants: reg,
  });
  const r: any = await callAttendance(client, { meeting_id: "111222333", date: "2026-10-16" }, () => Date.parse("2026-10-16T19:00:00Z"));
  assert.equal(r.status, "done");
  assert.equal(r.session_used.start_time, "2026-10-16T15:58:00Z");
  assert.equal(r.registered, 4); // team + "Otherside Team" removed
  assert.deepEqual(r.attended.map((x: any) => x.email).sort(), ["a@x.com", "b@x.com"]);
  assert.equal(r.attended.find((x: any) => x.email === "a@x.com").vip, true);
  assert.equal(r.attended.find((x: any) => x.email === "a@x.com").minutes, 70);
  assert.equal(r.attended.find((x: any) => x.email === "b@x.com").matched_by, "name");
  const missed = r.missed.map((x: any) => x.email).sort();
  assert.deepEqual(missed, ["c@x.com", "d@x.com"]);
  assert.equal(r.missed.find((x: any) => x.email === "c@x.com").joined_briefly, true);
  assert.equal(r.missed.find((x: any) => x.email === "d@x.com").joined_briefly, false);
  assert.deepEqual(r.attended_not_registered.map((x: any) => x.email), ["z@x.com"]);
});
