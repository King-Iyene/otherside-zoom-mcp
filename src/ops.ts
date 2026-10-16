import { ZoomClient, ZoomError } from "./zoomClient.js";

/** Zoom meeting id, digits only (can exceed 10 digits). */
export type MeetingId = string;

export interface Registrant {
  id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  status?: string;
  join_url?: string;
  create_time?: string;
  [k: string]: unknown;
}

const REGISTRANT_PAGE_SIZE = 300;
const MAX_PAGES = 20;

const enc = (id: string) => encodeURIComponent(id);
const sameEmail = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export async function whoami(c: ZoomClient) {
  await c.getToken();
  const token = "ok (OAuth token obtained)";
  try {
    const { data } = await c.request<any>("GET", "/users/me");
    return {
      token,
      user: { id: data?.id, email: data?.email, display_name: data?.display_name, type: data?.type, account_id: data?.account_id, timezone: data?.timezone },
    };
  } catch (e) {
    // Token works but the app lacks the user:read scope: still a successful connection test.
    if (e instanceof ZoomError && (e.status === 400 || e.status === 403)) {
      return { token, user: "not available: " + e.message + " (add the user:read:user:admin scope to see it; not needed for registrant work)" };
    }
    throw e;
  }
}

export async function listMeetings(
  c: ZoomClient,
  a: { user_id?: string; type?: string; topic_contains?: string; page_size?: number; include_occurrences?: boolean; max_occurrences?: number },
) {
  const out: any[] = [];
  let token: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data } = await c.request<any>("GET", `/users/${enc(a.user_id ?? "me")}/meetings`, {
      query: { type: a.type ?? "upcoming", page_size: a.page_size ?? 100, next_page_token: token },
    });
    out.push(...(data?.meetings ?? []));
    token = data?.next_page_token || undefined;
    if (!token) break;
  }
  const seen = new Set<string>();
  const unique = out.filter((m) => (seen.has(String(m.id)) ? false : (seen.add(String(m.id)), true))); // Zoom lists each occurrence of a recurring meeting separately
  const needle = a.topic_contains?.toLowerCase();
  const meetings = needle ? unique.filter((m) => String(m.topic ?? "").toLowerCase().includes(needle)) : unique;
  if (a.include_occurrences) {
    for (const m of meetings) {
      if (m.type === 8 || m.type === 3) {
        const full = await getMeeting(c, { meeting_id: String(m.id) });
        const now = Date.now();
        m.occurrences = (full.occurrences ?? [])
          .filter((o: any) => o.status !== "deleted" && Date.parse(o.start_time) >= now)
          .slice(0, a.max_occurrences ?? 10);
        m.registration = full.registration;
      }
    }
  }
  return { count: meetings.length, meetings };
}

export async function getMeeting(c: ZoomClient, a: { meeting_id: MeetingId; occurrence_id?: string }) {
  const { data } = await c.request<any>("GET", `/meetings/${enc(a.meeting_id)}`, {
    query: { occurrence_id: a.occurrence_id },
  });
  const s = data?.settings ?? {};
  return {
    id: data?.id,
    topic: data?.topic,
    type: data?.type,
    start_time: data?.start_time,
    timezone: data?.timezone,
    duration: data?.duration,
    recurrence: data?.recurrence,
    registration_url: data?.registration_url,
    registration: {
      approval_type: s.approval_type, // 0 auto-approve, 1 manual, 2 no registration required
      registration_type: s.registration_type, // 1 register once for all, 2 each occurrence, 3 choose occurrences
      registrants_confirmation_email: s.registrants_confirmation_email,
      registrants_email_notification: s.registrants_email_notification,
      close_registration: s.close_registration,
      meeting_authentication: s.meeting_authentication,
    },
    occurrences: data?.occurrences ?? [],
  };
}

export async function listRegistrants(
  c: ZoomClient,
  a: { meeting_id: MeetingId; status?: string; occurrence_id?: string; all_pages?: boolean; page_size?: number; next_page_token?: string; email?: string },
) {
  const registrants: Registrant[] = [];
  let token = a.next_page_token;
  let total: number | undefined;
  let pages = 0;
  do {
    const { data } = await c.request<any>("GET", `/meetings/${enc(a.meeting_id)}/registrants`, {
      query: {
        status: a.status ?? "approved",
        occurrence_id: a.occurrence_id,
        page_size: a.page_size ?? REGISTRANT_PAGE_SIZE,
        next_page_token: token,
      },
    });
    registrants.push(...(data?.registrants ?? []));
    total = data?.total_records;
    token = data?.next_page_token || undefined;
    pages++;
  } while (a.all_pages && token && pages < MAX_PAGES);
  const filtered = a.email ? registrants.filter((r) => sameEmail(r.email, a.email)) : registrants;
  return { total_records: total, returned: filtered.length, next_page_token: token, registrants: filtered };
}

/** Looks the person up among approved + pending registrants (optionally for one occurrence). */
async function findActive(c: ZoomClient, meeting_id: string, email: string, occurrence_id?: string): Promise<Registrant[]> {
  const found: Registrant[] = [];
  for (const status of ["approved", "pending"]) {
    const r = await listRegistrants(c, { meeting_id, status, occurrence_id, all_pages: true, email });
    found.push(...r.registrants.map((x) => ({ ...x, status: x.status ?? status })));
  }
  return found;
}

const trim = (r: Registrant) => ({
  id: r.id,
  email: r.email,
  first_name: r.first_name,
  last_name: r.last_name,
  status: r.status,
  join_url: r.join_url,
});

export interface AddArgs {
  meeting_id: MeetingId;
  email: string;
  first_name: string;
  last_name?: string;
  occurrence_ids?: string[];
  dry_run?: boolean;
}

export async function addRegistrant(c: ZoomClient, a: AddArgs) {
  const occ = a.occurrence_ids?.length ? a.occurrence_ids.join(",") : undefined;
  const request = {
    method: "POST",
    path: `/meetings/${a.meeting_id}/registrants`,
    query: occ ? { occurrence_ids: occ } : {},
    body: { email: a.email, first_name: a.first_name, ...(a.last_name ? { last_name: a.last_name } : {}) },
  };
  const existing = (await findActive(c, a.meeting_id, a.email)).map(trim);
  if (a.dry_run) {
    return { dry_run: true, would_send: request, existing_registrations_for_email: existing };
  }
  const { status, data } = await c.request<any>("POST", `/meetings/${enc(a.meeting_id)}/registrants`, {
    query: occ ? { occurrence_ids: occ } : undefined,
    body: request.body,
  });
  const verification = await verifyPresent(c, a.meeting_id, a.email, a.occurrence_ids, a.first_name, a.last_name);
  return {
    dry_run: false,
    http_status: status,
    zoom_response: data,
    join_url: data?.join_url,
    verification,
  };
}

async function verifyPresent(c: ZoomClient, meeting_id: string, email: string, occurrence_ids?: string[], first?: string, last?: string) {
  const targets: (string | undefined)[] = occurrence_ids?.length ? occurrence_ids : [undefined];
  const checks = [];
  for (const o of targets) {
    const hits = await findActive(c, meeting_id, email, o);
    const hit = hits[0];
    checks.push({
      occurrence_id: o,
      present: !!hit,
      status: hit?.status,
      registrant_id: hit?.id,
      join_url: hit?.join_url,
      name_matches: hit ? (first === undefined || hit.first_name === first) && (last === undefined || (hit.last_name ?? "") === last) : false,
    });
  }
  return { verified: checks.every((x) => x.present), re_read: checks };
}

export interface CancelArgs {
  meeting_id: MeetingId;
  email: string;
  occurrence_id?: string;
  dry_run?: boolean;
}

export async function cancelRegistrant(c: ZoomClient, a: CancelArgs) {
  const matches = await findActive(c, a.meeting_id, a.email, a.occurrence_id);
  if (matches.length === 0) {
    return { performed: false, reason: "No approved/pending registrant with that email" + (a.occurrence_id ? " for that occurrence" : "") + ". Nothing was changed.", dry_run: !!a.dry_run };
  }
  if (matches.length > 1) {
    return { performed: false, reason: "More than one registrant matched this email; refusing to guess.", matches: matches.map(trim), dry_run: !!a.dry_run };
  }
  const target = matches[0];
  const request = {
    method: "PUT",
    path: `/meetings/${a.meeting_id}/registrants/status`,
    query: a.occurrence_id ? { occurrence_id: a.occurrence_id } : {},
    body: { action: "cancel", registrants: [{ id: target.id, email: target.email }] },
  };
  if (a.dry_run) return { dry_run: true, would_cancel: trim(target), would_send: request };

  const { status } = await c.request("PUT", `/meetings/${enc(a.meeting_id)}/registrants/status`, {
    query: { occurrence_id: a.occurrence_id },
    body: request.body,
  });
  const after = await findActive(c, a.meeting_id, a.email, a.occurrence_id);
  const verified = after.length === 0;
  return {
    dry_run: false,
    performed: true,
    http_status: status,
    cancelled: trim(target),
    verification: {
      verified,
      still_registered: after.map(trim),
      ...(verified
        ? {}
        : { warning: "Zoom returned success but the registrant is still approved/pending. Check the occurrence_id (it is required for recurring meetings) and retry or check in Zoom." }),
    },
  };
}

export interface ReRegisterArgs {
  meeting_id: MeetingId;
  email: string;
  first_name: string;
  last_name?: string;
  cancel_occurrence_id?: string;
  add_occurrence_ids?: string[];
  dry_run?: boolean;
}

/** Zoom has no endpoint to edit a registrant's name, so: cancel, confirm gone, then add again with the new name. */
export async function reRegister(c: ZoomClient, a: ReRegisterArgs) {
  const fullName = `${a.first_name} ${a.last_name ?? ""}`.trim();
  const plan = [
    `1. Cancel the existing registration for ${a.email}` + (a.cancel_occurrence_id ? ` (occurrence ${a.cancel_occurrence_id})` : ""),
    "2. Re-read to confirm it is gone (abort if not)",
    `3. Add ${a.email} as "${fullName}"` + (a.add_occurrence_ids?.length ? ` for occurrences ${a.add_occurrence_ids.join(",")}` : ""),
    "4. Re-read to confirm the new registration and join_url",
  ];
  const cancel = await cancelRegistrant(c, { meeting_id: a.meeting_id, email: a.email, occurrence_id: a.cancel_occurrence_id, dry_run: a.dry_run });
  if (a.dry_run) {
    const add = await addRegistrant(c, { meeting_id: a.meeting_id, email: a.email, first_name: a.first_name, last_name: a.last_name, occurrence_ids: a.add_occurrence_ids, dry_run: true });
    return { dry_run: true, plan, cancel, add };
  }
  if (!(cancel as any).performed || !(cancel as any).verification?.verified) {
    return { dry_run: false, aborted: true, reason: "Cancel did not complete and verify, so nothing was added.", cancel };
  }
  const add = await addRegistrant(c, { meeting_id: a.meeting_id, email: a.email, first_name: a.first_name, last_name: a.last_name, occurrence_ids: a.add_occurrence_ids });
  return { dry_run: false, cancel, add, join_url: (add as any).join_url };
}

export interface NextArgs {
  meeting_id: MeetingId;
  email: string;
  first_name: string;
  last_name?: string;
  count: number;
  dry_run?: boolean;
}

export async function addToNextMeetings(c: ZoomClient, a: NextArgs) {
  const m = await getMeeting(c, { meeting_id: a.meeting_id });
  const now = Date.now();
  const upcoming = (m.occurrences as any[])
    .filter((o) => o.status !== "deleted" && Date.parse(o.start_time) >= now)
    .sort((x, y) => Date.parse(x.start_time) - Date.parse(y.start_time))
    .slice(0, a.count);
  if (upcoming.length === 0) {
    return { performed: false, reason: "This meeting has no upcoming occurrences (not recurring, or all past).", meeting: { id: m.id, topic: m.topic, type: m.type } };
  }
  const notes: string[] = [];
  if (upcoming.length < a.count) notes.push(`Only ${upcoming.length} upcoming occurrence(s) exist; requested ${a.count}.`);
  if (m.registration.registration_type === 1) notes.push("This meeting uses registration_type 1 (register once, attend any occurrence); occurrence_ids may be ignored by Zoom.");
  if (m.registration.approval_type === 2) notes.push("Registration is not required/enabled on this meeting; Zoom will reject registrants.");
  const res = await addRegistrant(c, {
    meeting_id: a.meeting_id,
    email: a.email,
    first_name: a.first_name,
    last_name: a.last_name,
    occurrence_ids: upcoming.map((o) => String(o.occurrence_id)),
    dry_run: a.dry_run,
  });
  return {
    meeting: { id: m.id, topic: m.topic },
    occurrences_selected: upcoming.map((o) => ({ occurrence_id: o.occurrence_id, start_time: o.start_time })),
    notes,
    ...res,
  };
}
