#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentials } from "./config.js";
import { createServer } from "./server.js";
import { ZoomClient } from "./zoomClient.js";

async function main() {
  // Credentials are read lazily so the server still starts (and tools explain what is missing) before they are filled in.
  const server = createServer(new ZoomClient(() => loadCredentials()));
  await server.connect(new StdioServerTransport());
  console.error("zoom-mcp ready (stdio)");
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
