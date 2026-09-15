// POSITIVE FIXTURE — must compile.
import type { Metadata } from "next";

import { createStorefrontRoute } from "@/routes/factory";
import { sealRoute } from "@/routes/core";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
type Data = { headline: string };

const load = async (_props: Props) =>
  sealRoute<Data>({
    data: { headline: "Demo" },
    refreshAfterMs: 0,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });

// Page-owned metadata: both exports exist.
const withMetadata = createStorefrontRoute<Props, Data>({
  load,
  render: (data) => <h1>{data.headline}</h1>,
  metadata: async (_props): Promise<Metadata> => ({ title: "Demo" }),
});
export const generateMetadata = withMetadata.generateMetadata;
export default withMetadata.Page;

// Layout or static metadata: only Page exists, and that is enough.
const withoutMetadata = createStorefrontRoute<Props, Data>({
  load,
  render: (data) => <h1>{data.headline}</h1>,
});
export const OtherPage = withoutMetadata.Page;
