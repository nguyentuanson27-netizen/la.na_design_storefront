import { CommerceEventReporter as SharedCommerceEventReporter } from "@/components/analytics/commerce-event-reporter";

/**
 * The brand layer's mount point for a page-level commerce event -- an adapter, not a reimplementation.
 *
 * The route shell mounts a reporter for the route's own canonical event, which covers most pages. A
 * page that renders a second merchandised grid has a second list impression to publish, and under
 * the route boundary `src/app` can only reach `src/components/brand`. So the shared reporter is
 * named here in brand terms.
 *
 * Only the component crosses. `isCommerceTrackingEnabled` deliberately does not: it reads
 * deployment config on the server and belongs in a route loader, not in markup.
 */

export const CommerceEventReporter = SharedCommerceEventReporter;
