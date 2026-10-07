// Test-only preload: Graph requests never reach Meta, and only synthetic event data is captured.
import { appendFileSync } from "node:fs";

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "graph.facebook.com") return nativeFetch(input, init);
  if (!process.env.META_TEST_CAPTURE_FILE) throw new Error("Missing test capture path");
  const payload = JSON.parse(String(init?.body));
  for (const event of payload.data) appendFileSync(process.env.META_TEST_CAPTURE_FILE, `${JSON.stringify(event)}\n`);
  return Response.json({ events_received: payload.data.length, fbtrace_id: "synthetic_test_trace" });
};
