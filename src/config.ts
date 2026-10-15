import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ZoomCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

/** User-level config file, outside any repo. Override the location with ZOOM_MCP_CONFIG. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZOOM_MCP_CONFIG || join(homedir(), ".zoom-mcp", "credentials.json");
}

/**
 * Environment variables win; any still-missing value is read from the config file
 * ({"ZOOM_ACCOUNT_ID": "...", "ZOOM_CLIENT_ID": "...", "ZOOM_CLIENT_SECRET": "..."}).
 * Never logs or returns secret values in errors.
 */
export function loadCredentials(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): ZoomCredentials {
  const keys = ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"] as const;
  const vals: Record<string, string | undefined> = {};
  for (const k of keys) vals[k] = env[k]?.trim() || undefined;

  const path = defaultConfigPath(env);
  if (keys.some((k) => !vals[k])) {
    try {
      const file = JSON.parse(readFile(path)) as Record<string, unknown>;
      for (const k of keys) {
        const v = file[k];
        if (!vals[k] && typeof v === "string" && v.trim()) vals[k] = v.trim();
      }
    } catch {
      /* missing or unreadable file: fall through to the error below */
    }
  }
  const missing = keys.filter((k) => !vals[k]);
  if (missing.length) {
    throw new Error(
      `Missing Zoom credential(s): ${missing.join(", ")}. Set them as environment variables or in ${path} ` +
        `as JSON {"ZOOM_ACCOUNT_ID":"...","ZOOM_CLIENT_ID":"...","ZOOM_CLIENT_SECRET":"..."}. See README.`,
    );
  }
  return {
    accountId: vals.ZOOM_ACCOUNT_ID!,
    clientId: vals.ZOOM_CLIENT_ID!,
    clientSecret: vals.ZOOM_CLIENT_SECRET!,
  };
}
