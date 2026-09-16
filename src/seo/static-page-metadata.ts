import type { Metadata } from "next";

type StaticPageMetadataInput = Readonly<{
  origin: string;
  indexingEnabled: boolean;
  pathname: string;
  searchParams: object;
  title?: string | Readonly<{ absolute: string }>;
  description?: string;
}>;

const SELF_CANONICAL_STATIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/collections",
  "/about",
  "/contact",
  "/returns",
  "/shipping",
  "/size-guide",
]);

export function buildStaticPageMetadata({
  origin,
  indexingEnabled,
  pathname,
  searchParams,
  title,
  description,
}: StaticPageMetadataInput): Metadata {
  const metadata: Metadata = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };

  if (!indexingEnabled) return metadata;
  if (!SELF_CANONICAL_STATIC_PATHS.has(pathname)) return metadata;

  const hasQuery = Object.values(searchParams).some((value) => value !== undefined);
  if (hasQuery) return metadata;

  return {
    ...metadata,
    alternates: {
      canonical: pathname === "/" ? origin : new URL(pathname, origin).toString(),
    },
  };
}
