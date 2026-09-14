// NEGATIVE FIXTURE — must not compile.
// Spread and Object.values are the obvious ways around a symbol-keyed payload. If either yields the
// payload, "opaque" is only true of dotted access.
import type { RouteHandle } from "@/routes/core";

declare const handle: RouteHandle<{ secret: string }>;

const copied = { ...handle };
export const viaSpread = copied.data;
export const viaValues: { secret: string } = Object.values(handle)[0];
