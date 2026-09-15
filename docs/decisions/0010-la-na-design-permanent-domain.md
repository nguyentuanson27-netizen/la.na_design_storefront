# ADR 0010: La.na Design permanent production domain `www.lanadesign.vn`

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes, for this repository:** ADR 0009
- **Owner decision:** `www.lanadesign.vn` is the official permanent La.na Design storefront hostname.

## Context

This repository is the La.na Design production fork of `storefront-core-kit`, branched at
`ff3793cf4ce2c019db1562b28a7471998a8f66f8`. It inherits the decision records of the template's first
brand, LA Clothing, including ADR 0009, which selected `www.lafashion.asia`. That hostname belongs to
a different brand and has no authority here.

`project.config.json` is the committed source of project identity, and
`tests/domain/project-identity-operations.test.ts` requires
`OFFICIAL_PRODUCTION_STOREFRONT_HOST` to mirror its `productionDomain`. A permanent hostname
therefore has to be decided before the identity can be committed at all — it is not deferrable to
launch.

The owner first supplied the apex `lanadesign.vn`, then corrected the selection to the `www` form.
Both spellings were considered; only one can be canonical, because the release preflight admits
exactly one production hostname and rejects every near miss, the sibling apex included.

## Decision

1. **Official permanent hostname:** `www.lanadesign.vn` is the canonical production hostname.
2. **Committed identity:** `project.config.json` declares `productionDomain: "www.lanadesign.vn"`,
   and `OFFICIAL_PRODUCTION_STOREFRONT_HOST` mirrors it. Every other copy is derived or checked
   against it.
3. **`www` is canonical:** the bare apex `lanadesign.vn` is not canonical authority and is rejected
   by the identity preflight. A redirect from the apex may be configured at the public edge, but it
   must not be claimed until DNS/TLS/edge behaviour is actually observed.
4. **Legacy temporary hostname is retained as-is:** `LEGACY_TEMPORARY_STOREFRONT_HOST` stays
   `la.lanadesign.vn` and keeps its place in the temporary-production/noindex guard and in the
   release preflight's approved-legacy exemption. The owner reviewed removing it and decided against
   it. It must never become an alternate indexable canonical origin. Note it is a subdomain of this
   brand's own apex, which is a coincidence of the shared registrable domain, not a grant of
   authority.
5. **Selecting a domain does not enable indexing:** `SEARCH_INDEXING_ENABLED=false` remains the
   deployment default and the codebase default is fail-closed. Turning it on still requires
   production verification and a separate explicit human approval.
6. **Request data is not authority:** `Host`, forwarded-host headers and query parameters cannot
   substitute for the server-owned `APP_DOMAIN`.
7. **External cutover is operational work:** this ADR does not claim the hostname is live. DNS, TLS,
   public edge routing, VPS environment, health checks and Search/Merchant verification all require
   observed evidence.

## Expected production posture at first deploy

- `APP_DOMAIN=www.lanadesign.vn`
- `BETTER_AUTH_URL=https://www.lanadesign.vn`
- `SEARCH_INDEXING_ENABLED=false`
- HTML remains `noindex, nofollow`; canonical links and the sitemap stay withheld under the existing
  search-exposure policy.

## Verified at the time of this decision

Offline, against the committed identity: the preflight accepts `www.lanadesign.vn` as `production`
and rejects the apex `lanadesign.vn`, the previous brand's `www.lafashion.asia`, and a
`DATABASE_URL` naming the previous brand's database. `pnpm release:check` reports `ok: true` with
`appDomainScope: "local"` for local development.

Not verified, and not claimed: DNS, TLS, edge routing, and any behaviour of the live hostname.
