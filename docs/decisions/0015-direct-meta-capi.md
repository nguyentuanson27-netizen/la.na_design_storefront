# ADR 0015 — Direct Meta Pixel and Conversions API

Status: Accepted implementation decision in PR #110; account activation is unverified.
Date: 2026-10-07

## Decision

Meta remains direct browser Pixel plus direct Next.js/server CAPI for PageView, ViewContent, AddToCart, InitiateCheckout and Purchase. GTM/sGTM migration is excluded. A tracking failure never changes commerce success.

- PageView uses a browser occurrence UUID. ViewContent/InitiateCheckout use a UUID inside a server-signed, 15-minute receipt; the browser Pixel and receipt-only signal share it. Prefetch/SSR do not deliver events. Cached revisit refreshes server facts. The existing DB rate limiter bounds signals per trusted-client hash (60/minute), then globally (600/minute); rejected clients do not spend the global budget.
- AddToCart uses the accepted cart transaction's positive quantity delta, price and server UUID. Cart page and drawer increments use the same boundary. No browser-supplied vendor payload is accepted.
- Meta content identity stays the existing public PDP slug. The committed PDP add verifies the selected option through the complete server PDP projection and stores `CartItem.sourceProductSlug`. Quantity edits retain it; new order lines freeze it as `metaContentId`. This is one nullable field because the component owner cannot identify which public PDP was used. Legacy private cart/order lines without evidence fail closed for Meta, without blocking commerce. No inferred parent or internal DB ID is exported.
- Purchase remains confirmed-only with `event_id = publicCode`, including reconciliation. Original POS submission time and the first serialized payload are frozen. Validated API acknowledgement clears saved attribution and strips `user_data`/`event_source_url`, retaining immutable browser business facts. Expired attribution is cleared on reporting and bounded maintenance in existing PageView/manual retry paths. Pending attribution is eligible for seven days; cleanup needs one of those paths to run.
- Transport has bounded retries/timeouts and validates `events_received`; logs use fixed, non-PII metadata. Token and user data remain server-only. Graph API defaults to v26.0 based on the official source recorded in the audit.

## Limits

No durable non-Purchase queue, new worker, or Meta account change is introduced. Meta Catalog is optional for website tracking; the owner has not connected one. Catalog-specific ID redesign remains deferred until real Catalog/Pixel/feed identity is verified. Real Test Events, dedup, attribution cookies and domain verification remain manual activation checks.

This amends the Meta sections of the shopping analytics specification, plan and task checklist. Merchant/Google/TikTok identity contracts and account gates are unchanged. See [audit and verification](../audits/meta-ads-2026-10-07.md).
