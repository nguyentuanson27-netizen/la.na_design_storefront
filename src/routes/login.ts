import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * The login page's loader.
 *
 * Session state belongs to the auth panel, which reads it on the client.
 */

export type LoginRouteProps = Readonly<Record<string, never>>;

export type LoginViewModel = Readonly<Record<string, never>>;

export async function loadLoginRoute(): Promise<RouteHandle<LoginViewModel>> {
  return sealRoute({
    data: Object.freeze({}),
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
