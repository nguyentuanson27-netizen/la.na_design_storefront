import type { Metadata } from "next";

import { FEEDBACK_PATH, readFeedbackContent } from "@/content/homepage-content";

import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

/**
 * The feedback gallery's metadata.
 *
 * Title and description are the owner-approved copy the feedback config owns -- this builder writes
 * none of its own. While that copy is pending the route 404s, and it yields empty metadata to match,
 * as the collection builder does for a collection with no story.
 */

export type FeedbackMetadataProps = StaticPageMetadataProps;

export async function buildFeedbackMetadata(props: FeedbackMetadataProps): Promise<Metadata> {
  const content = readFeedbackContent();
  if (content === null) return {};

  return buildEvergreenPageMetadata({
    props,
    pathname: FEEDBACK_PATH,
    title: content.metadataTitle,
    description: content.metadataDescription,
  });
}
