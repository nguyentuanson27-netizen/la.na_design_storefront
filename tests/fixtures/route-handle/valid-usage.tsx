// POSITIVE FIXTURE — must compile.
// The supported shape: a loader seals, the shell unseals, the page sees data only via the render prop.
import { sealRoute, StorefrontRoute, type RouteHandle } from "@/routes/core";

type Data = { headline: string };

export function load(): RouteHandle<Data> {
  return sealRoute<Data>({
    data: { headline: "Demo" },
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [{ "@context": "https://schema.org" }],
  });
}

export function Page() {
  return <StorefrontRoute handle={load()}>{(data) => <h1>{data.headline}</h1>}</StorefrontRoute>;
}
