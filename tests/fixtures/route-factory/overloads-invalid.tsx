// NEGATIVE FIXTURE — must not compile.
// Reaching for generateMetadata on the overload that does not provide it. If this compiled, a page
// in layout or static mode could re-export an undefined generateMetadata and ship no metadata.
import { createStorefrontRoute } from "@/routes/factory";
import { sealRoute } from "@/routes/core";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
type Data = { headline: string };

const route = createStorefrontRoute<Props, Data>({
  load: async (_props) =>
    sealRoute<Data>({
      data: { headline: "Demo" },
      refreshAfterMs: 0,
      trackingEvent: null,
      structuredData: [],
      pixelEvents: [],
    }),
  render: (data) => <h1>{data.headline}</h1>,
});

export const generateMetadata = route.generateMetadata;
