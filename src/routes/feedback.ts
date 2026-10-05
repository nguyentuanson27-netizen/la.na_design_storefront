import { notFound } from "next/navigation";
import { connection } from "next/server";

import { readDynamicFeedbackContent } from "@/commerce/feedback-repository";
import type { FeedbackImage } from "@/content/homepage-content";

import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * `/feedback`'s loader: the full configured feedback gallery (spec §7.6).
 *
 * The content is dynamically read from the database mirror (with fallback to repository config),
 * validated at `homepage-content.ts`. Until the heading, metadata copy and photographs are present,
 * the route 404s, as the collection route does for a collection with no story.
 */

export type FeedbackViewModel = Readonly<{
  title: string;
  images: readonly FeedbackImage[];
}>;

export type FeedbackRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadFeedbackRoute(): Promise<RouteHandle<FeedbackViewModel>> {
  await connection();
  const content = await readDynamicFeedbackContent();
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

