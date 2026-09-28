# ChatGPT Ads Pixel + Conversions API

## Scope

This integration measures confirmed storefront orders for ChatGPT Ads with both the browser
Measurement Pixel and the server-side Conversions API.

The canonical event is the standard `order_created` event. Both channels use the immutable public
order code (`LA-...`) as the event ID so OpenAI can deduplicate the browser and server copies.

## Runtime configuration

Set these values in the deployment environment:

- `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID`: the Pixel ID from Ads Manager. This is public configuration
  and is consumed at image build time because the CSP is built from the same value.
- `OPENAI_CONVERSIONS_API_KEY`: the server-only Conversions API key. Never expose this value to
  browser code or commit it.

Changing the Pixel ID requires rebuilding the application image.

## Event contract

A conversion is emitted only for an order whose immutable `OrderMirror` state is `CONFIRMED`.

Browser Pixel:
- standard event: `order_created`
- event ID: public order code
- currency: VND
- amount: immutable order total
- contents: immutable order-line snapshot facts

Conversions API:
- same standard event and event ID
- `action_source: "web"`
- canonical storefront `source_url`
- first-party `__oppref` and `__obref` values when present
- trusted client IP and user agent when available
- same immutable amount/items as the browser event

No checkout PII is added to the OpenAI Ads payload.

## Failure isolation

Tracking is optional. Missing configuration is a no-op. Pixel blocking, malformed attribution
cookies, CAPI timeouts, HTTP failures, or configuration errors must not change checkout success.
Server reporting runs after the confirmed order response path and logs only the public order code,
failure class, and HTTP status where applicable.

## Activation checklist

1. In Ads Manager → Conversions, create/reuse one website data source for Lana Design.
2. Copy its Pixel ID into `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID`.
3. Create a Conversions API key for the same ad account and store it only as
   `OPENAI_CONVERSIONS_API_KEY` on the server.
4. Create a standard conversion event setting for `order_created`, using the data source ID (not
   the Pixel ID) and the chosen click attribution window.
5. Rebuild/redeploy the storefront.
6. Place a test order and verify recent events show both browser (`pixel_sdk`) and server
   (`server_to_server`) delivery for the same event ID.
7. Confirm Ads Manager deduplicates the pair into one conversion before using the setting for
   campaign reporting or optimization.

## References

- https://developers.openai.com/ads/conversion-tracking
- https://developers.openai.com/ads/measurement-pixel
- https://developers.openai.com/ads/conversions-api
- https://developers.openai.com/ads/supported-events
