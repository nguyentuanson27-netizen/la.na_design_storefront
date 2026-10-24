/**
 * How a browser spec serves the app it drives.
 *
 * Locally each spec starts its own `next dev` in its own build directory: no build step, and the
 * page under test is compiled on first request. In CI the shard builds the app once and every spec
 * serves that build with `next start` instead (set `LA_E2E_PREBUILT_DIST_DIR` to the build's
 * `NEXT_DIST_DIR`). That is what shoppers are served, a page renders several times faster than
 * one a dev server compiles on demand, and it keeps dev-only behaviour out of the result: with
 * next 16.4.x a dev server intermittently re-navigates a page until `networkidle` times out and
 * loses focus moves, while the same specs pass every time against a production build.
 *
 * A spec that changes a `NEXT_PUBLIC_*` value per server cannot share one build (those are inlined
 * at build time) and keeps its own dev server or build.
 */
const prebuiltDistDir = process.env.LA_E2E_PREBUILT_DIST_DIR?.trim() || null;

export const NEXT_SERVER_COMMAND = prebuiltDistDir ? "start" : "dev";

/** The server's build directory: the shared production build in CI, the spec's own otherwise. */
export function nextServerEnv(devDistDir: string): { NEXT_DIST_DIR: string; NODE_ENV?: "production" } {
  return prebuiltDistDir ? { NEXT_DIST_DIR: prebuiltDistDir, NODE_ENV: "production" } : { NEXT_DIST_DIR: devDistDir };
}
