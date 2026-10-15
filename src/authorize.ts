// One-time user authorization for a General (User-managed) Zoom app:  npm run authorize
// Starts a local callback server, prints a Zoom URL for you to open, exchanges the returned code for tokens
// and saves them (with the rotating refresh token) in ~/.zoom-mcp/tokens.json. Prints no secrets.
import { createServer } from "node:http";
import { loadCredentials, defaultTokensPath } from "./config.js";
import { FileTokenStore } from "./zoomClient.js";

const PORT = Number(process.env.ZOOM_MCP_AUTH_PORT || 8787);
const redirect = process.env.ZOOM_MCP_REDIRECT_URI || `http://localhost:${PORT}/callback`;
const creds = loadCredentials();
const state = Math.random().toString(36).slice(2);

const authUrl =
  `https://zoom.us/oauth/authorize?response_type=code&client_id=${encodeURIComponent(creds.clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;

console.log("\n1. In your Zoom app > Basic Information, the OAuth Redirect URL (and allow list) must contain exactly:\n   " + redirect);
console.log("\n2. Open this URL in your browser and click Allow:\n\n" + authUrl + "\n");
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
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const r = await fetch(
      `https://zoom.us/oauth/token?grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirect)}`,
      { method: "POST", headers: { Authorization: `Basic ${basic}` } },
    );
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token || !body.refresh_token) {
      res.writeHead(500).end("Zoom rejected the code: " + (body.reason ?? body.error ?? r.status));
      console.error("Token exchange failed:", body.reason ?? body.error ?? r.status);
      return;
    }
    new FileTokenStore().write({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    });
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Zoom authorized. You can close this tab.");
    console.log("Authorized. Tokens saved to " + defaultTokensPath());
    console.log("Granted scopes: " + (body.scope ?? "(not reported)"));
    setTimeout(() => process.exit(0), 200);
  } catch (e) {
    res.writeHead(500).end("Error, see terminal.");
    console.error((e as Error).message);
  }
});
server.listen(PORT, "127.0.0.1");
