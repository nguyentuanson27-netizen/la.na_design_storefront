import { buildPolicyHubViewModel, type PolicyHubViewModel } from "./evergreen-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** The policy hub's loader. No request-time data: every topic on it is owner-approved and static. */

export type PoliciesRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadPoliciesRoute(): Promise<RouteHandle<PolicyHubViewModel>> {
  return sealRoute({
    data: buildPolicyHubViewModel(),
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
