# zoom-mcp

A small MCP server that lets Claude manage **Zoom meeting registrants** (add, cancel, re-register under a new name, add to the next N occurrences) using a Zoom Server-to-Server OAuth app. Built for Otherside's Catalyst calls, usable from any project. stdio transport; the Zoom logic (`src/ops.ts`, `src/zoomClient.ts`) is transport-free so an HTTP version can be added later (see bottom).

It never deletes meetings, and every write tool handles exactly one named person per call.

## 1. Zoom Marketplace app scopes

In your Server-to-Server OAuth app → **Scopes**, add (classic or granular both work):

| Need | Classic | Granular |
| --- | --- | --- |
| Read meetings | `meeting:read:admin` | `meeting:read:meeting:admin`, `meeting:read:list_meetings:admin` |
| Write meetings (registrant add) | `meeting:write:admin` | `meeting:write:registrant:admin` |
| Read registrants | `meeting:read:admin` | `meeting:read:list_registrants:admin` |
| Update registrant status (cancel) | `meeting:write:admin` | `meeting:update:registrant_status:admin` |
| Read users (whoami) | `user:read:admin` | `user:read:user:admin` |

Then make sure the app is **Activated**. Pre-requisites from Zoom: the meeting host must be Licensed (add registrant) / Pro or higher (list and status), and **registration must be enabled on the meetings**.

## 2. Credentials (you fill these in; never paste them into chat or a repo)

Either set environment variables `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, **or** edit this user-level file (already created with empty values):

```
C:\Users\KING\.zoom-mcp\credentials.json
{
  "ZOOM_ACCOUNT_ID": "...",
  "ZOOM_CLIENT_ID": "...",
  "ZOOM_CLIENT_SECRET": "..."
}
```

Environment variables win over the file. Override the file location with `ZOOM_MCP_CONFIG`. Credentials are read on first use, so no restart is needed after filling them in. Secrets are never printed or included in error messages. Tokens are cached in memory and refreshed about 5 minutes before expiry.

## 2b. If you only have a General (User-managed) app, not Server-to-Server

Leave `ZOOM_ACCOUNT_ID` empty and the server uses user OAuth instead (acts as you, so it can only manage meetings you host, or all of them if your role allows with admin scopes):

1. In the Zoom app > **Basic Information**, set the **OAuth Redirect URL** and add it to the **allow list**: `http://localhost:8765/callback` (if Zoom refuses http, use an https tunnel URL and set `ZOOM_MCP_REDIRECT_URI`).
2. In **Scopes** add the meeting, meeting-registrant and user read/write scopes from the table above (non-admin versions, e.g. `meeting:read`, `meeting:write`, `user:read`).
3. Put only `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` in `credentials.json`.
4. Run `npm run authorize`, open the printed URL, click **Allow**. Tokens (including a rotating refresh token) are saved to `C:UsersKING.zoom-mcp	okens.json`, never in the repo. Access tokens refresh automatically; if the refresh token ever lapses (Zoom expires unused ones), rerun `npm run authorize`.

Assumed (not yet confirmed live): Zoom accepting `http://localhost` redirect for an app in Development mode; the refresh-token lifetime and rotation behaviour as described in Zoom's OAuth docs.

## 3. Build and test

```powershell
cd C:\Users\KING\Desktop\zoom-mcp
npm install
npm run build
npm test          # mocked Zoom API, no network
npm run check -- Catalyst   # read-only: token + whoami + upcoming meetings whose topic contains "Catalyst"
```

## 4. Register in Claude

**Claude Code (and the Code tab of the desktop app), user scope, any project:**

```powershell
claude mcp add --scope user zoom -- node C:\Users\KING\Desktop\zoom-mcp\dist\index.js
```

(Already done for this machine.) Check it: `claude mcp list` should show `zoom: ... ✔ Connected`, or type `/mcp` inside a Claude Code session. Then ask Claude "run zoom_whoami".

**Claude desktop chat app:** edit `%APPDATA%\Claude\claude_desktop_config.json` and add inside `mcpServers`:

```json
"zoom": { "command": "node", "args": ["C:\\Users\\KING\\Desktop\\zoom-mcp\\dist\\index.js"] }
```

Restart the app fully; the tools appear under the connector/tools menu. (Credentials still come from the user file, so nothing secret goes in this JSON.) After code changes run `npm run build` again.

## Tools

| Tool | Writes? | What it does |
| --- | --- | --- |
| `zoom_whoami` | no | Gets a token, returns the Zoom user/account the app acts as |
| `zoom_list_meetings` | no | Upcoming meetings, optional topic filter, optional next occurrences + registration settings |
| `zoom_get_meeting` | no | Registration settings, recurrence, all occurrences with `occurrence_id` |
| `zoom_list_registrants` | no | By status (approved/pending/denied), optional occurrence and email filter, paging, includes `join_url` |
| `zoom_add_registrant` | yes | Add one person, optional `occurrence_ids`; returns Zoom's response and `join_url` |
| `zoom_cancel_registrant` | yes | Cancel one person (optional `occurrence_id`); looks them up by email first |
| `zoom_re_register` | yes | Cancel then add again with a new name; aborts if the cancel does not verify |
| `zoom_add_to_next_meetings` | yes | Add one person to the next N upcoming occurrences |

Safety: every write tool has `dry_run`, which **defaults to true** (reports the exact request; pass `dry_run: false` to act). After every real write the tool re-reads the registrant list and reports `verified` true/false. Cancel and re-register refuse if the email is not found or matches more than one registrant. The VIP name format (`VIP - [name]`) is not baked in: pass the first/last name exactly as it should appear, and confirm the format with King before relying on it.

## What is confirmed vs assumed

Confirmed against Zoom's official OpenAPI spec for the Meetings API (https://developers.zoom.us/api-hub/meetings/methods/endpoints.json, fetched 2026-10-15):

- **Add**: `POST /meetings/{id}/registrants`; query `occurrence_ids` is a comma-separated list (get them from Get a meeting); body requires `email` and `first_name` (`last_name` optional, 64 chars max); response has `registrant_id`, `join_url`, `occurrences`, `participant_pin_code`. 4,999 registrant cap.
- **Cancel**: `PUT /meetings/{id}/registrants/status`; query is `occurrence_id` (singular); body `action` is `approve|cancel|deny` with up to 30 `registrants` `{id, email}`; success is HTTP 204. There is an extra per-registrant, per-24-hours rate limit on this endpoint.
- **List**: `GET /meetings/{id}/registrants`; `status` is `pending|approved|denied`, `occurrence_id`, `page_size` (max 300), `next_page_token`; each record has `status`, `create_time`, `join_url`.
- **Names cannot be edited**: the spec has no update-registrant endpoint (only list, add, delete, status, batch add, questions). That is why `re_register` is cancel then add.
- A meeting's `registration_type` setting: 1 = register once for all occurrences, 2 = register per occurrence, 3 = choose occurrences. For type 1, `occurrence_ids` is not meaningful (the tools print a note).

Still assumed, because the docs do not say (test with a throwaway registrant first):

- Whether Zoom resends a confirmation/join email on add or re-add (depends on the meeting's "registrants confirmation email" setting; `zoom_get_meeting` shows the setting but not what Zoom actually sent).
- What Zoom does when you re-add an email that was just cancelled (new `registrant_id` and join_url vs. reusing the old). The tools return whatever Zoom returns.
- The forum-reported case of cancel returning 204 with no change when `occurrence_id` is wrong is not in the docs; the post-write verification exists to catch it.
- A cancelled registrant is assumed to drop out of the `approved`/`pending` lists (the verify step relies on this).
- `GET /users/me` for a Server-to-Server app returns the app owner (used only by `zoom_whoami`; if it errors, `zoom_list_meetings` with `user_id` set to the host's email still works).
- Meetings where the app account is not the host (scheduled-for-others) may need `user_id` set to the host.

## Exposing this to claude.ai on the web (not built)

claude.ai web connectors need a **remote HTTPS MCP endpoint**, not a local stdio process. Options:

1. **Small separate Vercel project** (fits how Otherside already deploys): wrap `createServer()` from `src/server.ts` in the SDK's Streamable HTTP transport as a serverless function, store the three credentials as Vercel env vars, and protect the endpoint (OAuth, which claude.ai connectors support, or at minimum a long secret path/bearer token, since anyone who reaches it can change registrations). Add it in claude.ai under Settings → Connectors as a custom connector. Stateless mode per request fits serverless; the in-memory token cache simply refreshes on cold start.
2. A tunnel (Cloudflare Tunnel/ngrok) to this machine: quick, but only works while the PC is on.
3. Skip the web: Claude Code and the desktop app already cover it locally.
