import { createInterface } from "node:readline";
import { createPdpVideoPlaybackSummary } from "../src/operations/pdp-video-playback-summary.ts";

// Pipe the app's raw JSON stdout log stream here; no raw input or identifying fields are output.
const summary = createPdpVideoPlaybackSummary();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) summary.add(line);
process.stdout.write(`${JSON.stringify(summary.result())}\n`);
