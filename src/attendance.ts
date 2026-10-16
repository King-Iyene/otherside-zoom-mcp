// Call attendance (read-only): who registered for one call and who actually joined.
import { listRegistrants, type MeetingId } from "./ops.js";
import type { ZoomClient } from "./zoomClient.js";

export interface AttendanceArgs {
  meeting_id: MeetingId;
  /** Call date in America/New_York, YYYY-MM-DD. Default: today (ET). */
  date?: string;
  /** Minutes on the call to count as present. Default 5. */
  min_minutes?: number;
  /** Emails ending with these domains are team, not men. Default ["joinotherside.com"]. */
  exclude_domains?: string[];
  /** Extra emails to ignore (notetakers etc). */
  exclude_emails?: string[];
}

const enc = (id: string) => encodeURIComponent(id);

const etDate = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

const normName = (s?: string) =>
  (s ?? "")
    .toLowerCase()
    .replace(/^\s*vip\s*-\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

async function allParticipants(c: ZoomClient, uuid: string) {
  const out: any[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    // Zoom wants a UUID that starts with "/" or contains "//" double-encoded.
    const { data } = await c.request<any>("GET", `/past_meetings/${enc(enc(uuid))}/participants`, {
      query: { page_size: 300, next_page_token: token },
    });
    out.push(...(data?.participants ?? []));
    token = data?.next_page_token || undefined;
    pages++;
  } while (token && pages < 20);
  return out;
}

/**
 * Picks the real session of that day (the one with most people, within a window around the scheduled start),
 * because Zoom keeps several short sessions per day (tests, host rejoins).
 */
export async function callAttendance(c: ZoomClient, a: AttendanceArgs, now: () => number = Date.now) {
  const date = a.date ?? etDate(new Date(now()).toISOString());
  const minSec = (a.min_minutes ?? 5) * 60;
  const domains = (a.exclude_domains ?? ["joinotherside.com"]).map((d) => d.toLowerCase());
  const excludeEmails = new Set((a.exclude_emails ?? ["notetaker@fathom.video"]).map((e) => e.toLowerCase()));
  const isTeam = (email: string) => !email || excludeEmails.has(email) || domains.some((d) => email.endsWith("@" + d));

  const { data: meeting } = await c.request<any>("GET", `/meetings/${enc(a.meeting_id)}`, { query: { show_previous_occurrences: "true" } });
  const occ = (meeting?.occurrences ?? []).find((o: any) => etDate(o.start_time) === date);
  if (!occ) return { status: "no_call_that_day", meeting_id: a.meeting_id, topic: meeting?.topic, date };
  const startMs = Date.parse(occ.start_time);
  const durationMin = Number(occ.duration ?? meeting?.duration ?? 90);

  // Live check: if the meeting is running right now, the report must wait.
  let live: boolean | "unknown" = "unknown";
  try {
    const { data } = await c.request<any>("GET", `/users/me/meetings`, { query: { type: "live", page_size: 300 } });
    live = (data?.meetings ?? []).some((m: any) => String(m.id) === String(a.meeting_id));
  } catch {
    live = "unknown";
  }
  if (live === true) {
    return { status: "live", meeting_id: a.meeting_id, topic: meeting?.topic, date, call_start: occ.start_time, note: "The call is still running. Report later." };
  }
  if (now() < startMs) return { status: "not_started", meeting_id: a.meeting_id, topic: meeting?.topic, date, call_start: occ.start_time };

  let instances: any[] = [];
  try {
    const { data } = await c.request<any>("GET", `/past_meetings/${enc(a.meeting_id)}/instances`);
    instances = data?.meetings ?? [];
  } catch (e) {
    return { status: "no_past_data", message: (e as Error).message, meeting_id: a.meeting_id, date };
  }
  const near = instances.filter((i) => {
    const t = Date.parse(i.start_time);
    return t >= startMs - 45 * 60_000 && t <= startMs + (durationMin + 120) * 60_000;
  });
  if (!near.length) {
    return { status: "no_session_found", meeting_id: a.meeting_id, topic: meeting?.topic, date, call_start: occ.start_time, note: "Zoom has no past session near the scheduled time yet (data can lag 10-30 min)." };
  }

  let best: { inst: any; parts: any[]; people: number } | undefined;
  for (const inst of near.slice(0, 6)) {
    const parts = await allParticipants(c, inst.uuid);
    const people = new Set(parts.map((p) => String(p.user_email || p.name || "").toLowerCase())).size;
    if (!best || people > best.people) best = { inst, parts, people };
  }
  const parts = best!.parts;

  // Time on the call per person (rejoins add up).
  const byEmail = new Map<string, { name: string; seconds: number }>();
  const byName = new Map<string, number>();
  for (const p of parts) {
    const e = String(p.user_email ?? "").toLowerCase();
    const sec = Number(p.duration ?? 0);
    if (e) {
      const cur = byEmail.get(e) ?? { name: p.name, seconds: 0 };
      cur.seconds += sec;
      byEmail.set(e, cur);
    }
    const n = normName(p.name);
    if (n) byName.set(n, (byName.get(n) ?? 0) + sec);
  }

  const reg = await listRegistrants(c, { meeting_id: a.meeting_id, occurrence_id: occ.occurrence_id, all_pages: true, page_size: 300 });
  const teamName = /otherside team|notetaker|edward bertsch|samson odusanya|roberto pa[eé]z/i;
  const men = reg.registrants.filter(
    (r) => !isTeam(String(r.email ?? "").toLowerCase()) && !teamName.test(`${r.first_name ?? ""} ${r.last_name ?? ""}`),
  );

  const attended: any[] = [];
  const missed: any[] = [];
  for (const r of men) {
    const e = String(r.email ?? "").toLowerCase();
    const fullName = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
    let sec = byEmail.get(e)?.seconds;
    let how = "email";
    if (sec === undefined) {
      // Zoom hides the email of people who join from a browser; fall back to the display name.
      const n = normName(fullName);
      if (n && byName.has(n)) {
        sec = byName.get(n);
        how = "name";
      }
    }
    const row = {
      name: fullName,
      email: e,
      vip: /^\s*vip\s*-/i.test(r.first_name ?? ""),
      minutes: sec === undefined ? 0 : Math.round(sec / 60),
      matched_by: sec === undefined ? null : how,
    };
    if (sec !== undefined && sec >= minSec) attended.push(row);
    else missed.push({ ...row, joined_briefly: sec !== undefined });
  }
  const regEmails = new Set(men.map((m) => String(m.email ?? "").toLowerCase()));
  const extras = [...byEmail.entries()]
    .filter(([e, v]) => !regEmails.has(e) && !isTeam(e) && v.seconds >= minSec)
    .map(([e, v]) => ({ name: v.name, email: e, minutes: Math.round(v.seconds / 60) }));

  return {
    status: "done",
    meeting_id: a.meeting_id,
    topic: meeting?.topic,
    date,
    call_start: occ.start_time,
    session_used: { start_time: best!.inst.start_time, participant_rows: parts.length, people: best!.people },
    live_check: live,
    min_minutes: a.min_minutes ?? 5,
    registered: men.length,
    attended_count: attended.length,
    missed_count: missed.length,
    attended: attended.sort((x, y) => x.name.localeCompare(y.name)),
    missed: missed.sort((x, y) => x.name.localeCompare(y.name)),
    attended_not_registered: extras,
  };
}
