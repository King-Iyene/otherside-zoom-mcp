// Read-only connectivity check: `npm run check -- Catalyst`. Prints no secrets.
import { loadCredentials } from "./config.js";
import { whoami, listMeetings } from "./ops.js";
import { ZoomClient } from "./zoomClient.js";

const c = new ZoomClient(loadCredentials());
console.log(JSON.stringify(await whoami(c), null, 2));
const topic = process.argv[2];
const m = await listMeetings(c, { topic_contains: topic, include_occurrences: true, max_occurrences: 4 });
console.log(JSON.stringify(m, null, 2));
