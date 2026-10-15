// One-time user authorization for a General (User-managed) Zoom app:  npm run authorize
// Saves tokens (with the rotating refresh token) in ~/.zoom-mcp/tokens.json. Prints no secrets.
//  - default redirect http://localhost:8765/callback: a local server catches the code automatically
//  - any other redirect (set ZOOM_MCP_REDIRECT_URI, e.g. https://joinotherside.com/redirect): after clicking
//    Allow you paste the address-bar URL of the page you landed on into this terminal.
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { loadCredentials, defaultTokensPath } from "./config.js";
import { FileTokenStore } from "./zoomClient.js";

const PORT = Number(process.env.ZOOM_MCP_AUTH_PORT || 8765);
const redirect = process.env.ZOOM_MCP_REDIRECT_URI || `http://localhost:${PORT}/callback`;
const creds = loadCredentials();
const manual = !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(redirect);
const state = Math.random().toString(36).slice(2);

const authUrl =
  `https://zoom.us/oauth/authorize?response_type=code&client_id=${encodeURIComponent(creds.clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;

async function exchange(code: string): Promise<string | undefined> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const r = await fetch(
    `https://zoom.us/oauth/token?grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirect)}`,
    { method: "POST", headers: { Authorization: `Basic ${basic}` } },
  );
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token || !body.refresh_token) return "Zoom rejected the code: " + (body.reason ?? body.error ?? r.status);
  new FileTokenStore().write({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  console.log("Authorized. Tokens saved to " + defaultTokensPath());
  console.log("Granted scopes: " + (body.scope ?? "(not reported)"));
  return undefined;
}

console.log("\nRedirect URL in use: " + redirect + " (must be saved in the Zoom app's OAuth settings)");
console.log("\nOpen this URL in your browser and click Allow:\n\n" + authUrl + "\n");

if (manual) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = await rl.question(
    `After clicking Allow your browser lands on ${new URL(redirect).host} (the page itself may be blank or 404).\nPaste the full address from the address bar here and press Enter:\n> `,
  );
  rl.close();
  let u: URL | undefined;
  try {
    u = new URL(pasted.trim());
  } catch {
    /* handled below */
  }
  const code = u?.searchParams.get("code");
  if (!u || !code || u.searchParams.get("state") !== state) {
    console.error("No code found, or state mismatch. Run npm run authorize again and use the new link.");
    process.exit(1);
  }
  const err = await exchange(code);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  process.exit(0);
}

console.log("Waiting for Zoom to call back on " + redirect + " ...");
const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (u.pathname !== new URL(redirect).pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get("code");
  if (!code || u.searchParams.get("state") !== state) {
    res.writeHead(400).end("Missing code or state mismatch. Start again with npm run authorize.");
    return;
  }
  try {
    const err = await exchange(code);
    if (err) {
      res.writeHead(500).end(err);
      console.error(err);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Zoom authorized. You can close this tab.");
    setTimeout(() => process.exit(0), 200);
  } catch (e) {
    res.writeHead(500).end("Error, see terminal.");
    console.error((e as Error).message);
  }
});
server.listen(PORT, "127.0.0.1");
