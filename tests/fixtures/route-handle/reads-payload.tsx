// NEGATIVE FIXTURE — must not compile.
// A page trying to read route data straight off the handle, skipping the shell. This is the accident
// the opaque handle exists to stop.
import { sealRoute, type RouteHandle } from "@/routes/core";

declare const handle: RouteHandle<{ headline: string }>;

export const viaData = handle.data;
export const viaPayload = handle.payload;
export const viaIndex = handle["data"];
export const sealedThenRead = sealRoute({
  data: { headline: "x" },
  refreshAfterMs: 0,
  trackingEvent: null,
  structuredData: [],
}).data;
