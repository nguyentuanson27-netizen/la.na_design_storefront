import { notFound } from "next/navigation";

import { readFeedbackContent, type FeedbackImage } from "@/content/homepage-content";

import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * `/feedback`'s loader: the full configured feedback gallery (spec §7.6).
 *
 * The content is repository config, validated at `homepage-content.ts`. Until the owner supplies the
 * heading, the metadata copy and the photographs, there is no page to publish -- inventing any of
 * them is exactly what the spec forbids -- so the route 404s, as the collection route does for a
 * collection with no story, and the homepage's `Xem thêm` link is absent for the same reason.
 */

export type FeedbackViewModel = Readonly<{
  title: string;
  images: readonly FeedbackImage[];
}>;

export type FeedbackRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadFeedbackRoute(): Promise<RouteHandle<FeedbackViewModel>> {
  const content = readFeedbackContent();
  if (content === null) notFound();

  return sealRoute({
    data: Object.freeze({ title: content.title, images: content.images }),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
