import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ops from "./ops.js";
import { callAttendance } from "./attendance.js";
import { ZoomClient, ZoomError } from "./zoomClient.js";

const meetingId = z.string().regex(/^\d{6,15}$/, "digits only, e.g. 81234567890").describe("Zoom meeting ID (digits only)");
const email = z.string().email();
const dryRun = z
  .boolean()
  .default(true)
  .describe("Defaults to TRUE: only report what would be sent to Zoom. Pass false to actually make the change.");

async function wrap(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const body = e instanceof ZoomError ? { message: e.message, http_status: e.status, zoom_body: e.body } : { message: (e as Error).message };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  }
}

export function createServer(client: ZoomClient): McpServer {
  const server = new McpServer({ name: "zoom-mcp", version: "0.1.0" });

  server.registerTool(
    "zoom_whoami",
    { description: "Test the Zoom connection: fetches an OAuth token and returns the Zoom user/account the app acts as. Read-only.", inputSchema: {} },
    () => wrap(() => ops.whoami(client)),
  );

  server.registerTool(
    "zoom_call_attendance",
    {
      description:
        "Who registered for one Catalyst call and who actually joined (read-only). Pass the meeting id and the call date in New York time (default today). Returns status: live (call still running, report later), not_started, no_session_found (Zoom data can lag 10-30 min), or done with attended / missed lists (VIP flag, minutes on the call) and anyone who joined without registering. Team emails (joinotherside.com) are excluded.",
      inputSchema: {
        meeting_id: meetingId,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Call date in America/New_York, YYYY-MM-DD. Default today."),
        min_minutes: z.number().int().min(1).max(90).optional().describe("Minutes on the call to count as present. Default 5."),
        exclude_domains: z.array(z.string()).optional(),
        exclude_emails: z.array(z.string()).optional(),
      },
    },
    (a) => wrap(() => callAttendance(client, a)),
  );

  server.registerTool(
    "zoom_list_meetings",
    {
      description:
        "List scheduled Zoom meetings (default: upcoming) for a host. Optionally filter by topic text (e.g. 'Catalyst') and include upcoming occurrence ids + registration settings for recurring meetings. Read-only.",
      inputSchema: {
        user_id: z.string().optional().describe("Host user id or email; default 'me'"),
        type: z.enum(["scheduled", "live", "upcoming", "upcoming_meetings"]).optional().describe("Default 'upcoming'"),
        topic_contains: z.string().optional(),
        include_occurrences: z.boolean().optional().describe("For recurring meetings, add the next occurrences and registration settings (one extra call per meeting)"),
        max_occurrences: z.number().int().min(1).max(50).optional(),
      },
    },
    (a) => wrap(() => ops.listMeetings(client, a)),
  );

  server.registerTool(
    "zoom_get_meeting",
    {
      description:
        "Get one meeting: topic, recurrence, registration settings (approval_type, registration_type, confirmation email setting) and all occurrences with occurrence_ids. Read-only.",
      inputSchema: { meeting_id: meetingId, occurrence_id: z.string().optional() },
    },
    (a) => wrap(() => ops.getMeeting(client, a)),
  );

  server.registerTool(
    "zoom_list_registrants",
    {
      description:
        "List a meeting's registrants by status (approved/pending/denied; default approved), optionally for one occurrence and/or filtered to one email. Includes join_url. all_pages follows next_page_token. Read-only.",
      inputSchema: {
        meeting_id: meetingId,
        status: z.enum(["approved", "pending", "denied"]).optional(),
        occurrence_id: z.string().optional(),
        email: email.optional().describe("Client-side filter to a single email"),
        all_pages: z.boolean().optional(),
        page_size: z.number().int().min(1).max(300).optional(),
        next_page_token: z.string().optional(),
      },
    },
    (a) => wrap(() => ops.listRegistrants(client, a)),
  );

  server.registerTool(
    "zoom_add_registrant",
    {
      description:
        "Register ONE person for a meeting (POST /meetings/{id}/registrants). For recurring meetings pass occurrence_ids to register for specific occurrences. Returns Zoom's response (registrant_id, join_url, occurrences) and re-reads the registrant list to verify. The name is used exactly as given (e.g. a VIP name format). dry_run defaults to true.",
      inputSchema: {
        meeting_id: meetingId,
        email,
        first_name: z.string().min(1).max(64),
        last_name: z.string().max(64).optional(),
        occurrence_ids: z.array(z.string()).max(50).optional(),
        dry_run: dryRun,
      },
    },
    (a) => wrap(() => ops.addRegistrant(client, a)),
  );

  server.registerTool(
    "zoom_cancel_registrant",
    {
      description:
        "Cancel ONE person's registration (PUT /meetings/{id}/registrants/status action=cancel). Looks the person up by email first (refuses if not found or ambiguous), pass occurrence_id for a single occurrence of a recurring meeting. Verifies afterwards by re-reading, because Zoom can answer 204 without changing anything. Never deletes the meeting. dry_run defaults to true.",
      inputSchema: { meeting_id: meetingId, email, occurrence_id: z.string().optional(), dry_run: dryRun },
    },
    (a) => wrap(() => ops.cancelRegistrant(client, a)),
  );

  server.registerTool(
    "zoom_re_register",
    {
      description:
        "Change a registrant's name (Zoom has no edit endpoint): cancel the existing registration, confirm it is gone, add again with the new name, verify, and return the new join_url. Aborts without adding if the cancel does not verify. dry_run defaults to true and shows both steps.",
      inputSchema: {
        meeting_id: meetingId,
        email,
        first_name: z.string().min(1).max(64),
        last_name: z.string().max(64).optional(),
        cancel_occurrence_id: z.string().optional(),
        add_occurrence_ids: z.array(z.string()).max(50).optional(),
        dry_run: dryRun,
      },
    },
    (a) => wrap(() => ops.reRegister(client, a)),
  );

  server.registerTool(
    "zoom_add_to_next_meetings",
    {
      description:
        "Register ONE person for the next N upcoming occurrences of a recurring meeting (picks occurrence_ids for you, then verifies each). Returns join_url. dry_run defaults to true and lists the occurrences it would use.",
      inputSchema: {
        meeting_id: meetingId,
        email,
        first_name: z.string().min(1).max(64),
        last_name: z.string().max(64).optional(),
        count: z.number().int().min(1).max(20),
        dry_run: dryRun,
      },
    },
    (a) => wrap(() => ops.addToNextMeetings(client, a)),
  );

  return server;
}
