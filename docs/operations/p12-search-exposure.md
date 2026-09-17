# Search exposure operations — La.na Design

The previous Brand #1 version of this runbook named `www.lafashion.asia` and ADR 0009 as current authority. Those statements are superseded for this repository.

## Current authority

- `project.config.json` and ADR 0010 select `www.lanadesign.vn` as the configured production hostname.
- `src/commerce/storefront-origin.ts` mirrors it as `OFFICIAL_PRODUCTION_STOREFRONT_HOST`.
- `la.lanadesign.vn` is retained only as the approved legacy temporary/noindex host.
- staging and local origins remain indexing-blocked.
- request `Host`, forwarded-host headers and query state are not origin authority.

Selecting/configuring the hostname does **not** prove DNS/TLS/edge cutover and does **not** approve organic indexing.

## Runtime contract

`SEARCH_INDEXING_ENABLED` must be explicitly `true` or `false` at release preflight.

When disabled, the storefront remains fail-closed for search exposure. When enabled, `src/seo/search-exposure.ts` only admits the approved permanent production origin and still applies its route/query policy. Temporary, staging, local and unrelated public hosts remain ineligible.

The exact route, pagination and crawl-block rules are owned by `src/seo/search-exposure.ts` plus its tests; this runbook deliberately does not duplicate that evolving list.

## Activation gate

Keep `SEARCH_INDEXING_ENABLED=false` unless the exact activation head has all required evidence:

1. explicit human approval to enable indexing;
2. exact-head CI/runtime checks green;
3. observed DNS, TLS and public-edge routing for `www.lanadesign.vn`;
4. deployed origin/auth configuration consistent with committed project identity;
5. canonical/noindex/robots/sitemap behavior verified on the deployed host;
6. current sitemap-capacity evidence within enforced limits;
7. legacy/staging hosts verified non-indexable.

`pnpm release:check` is a repository preflight, not proof of the external checks above.

## Rollback / containment

Search exposure can be contained independently by restoring `SEARCH_INDEXING_ENABLED=false` and redeploying a reviewed configuration. Do not use the former LA Clothing permanent domain as a rollback target.

Application release/rollback is covered by [`release-and-rollback.md`](./release-and-rollback.md). ADR 0010 remains the domain decision; it explicitly does not claim that external cutover is already live.
