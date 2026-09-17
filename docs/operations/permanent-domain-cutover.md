# Superseded — Brand #1 permanent-domain cutover

This path is retained only for historical links. Its former target, `www.lafashion.asia`, belongs to LA Clothing / Brand #1 and is **not** a valid deployment target for this repository.

Current La.na Design domain authority is:

- `project.config.json` — `productionDomain: "www.lanadesign.vn"`;
- [`ADR 0010`](../decisions/0010-la-na-design-permanent-domain.md) — supersedes ADR 0009 for this repository;
- `src/commerce/storefront-origin.ts` — mirrors the committed production hostname and retains `la.lanadesign.vn` only as a legacy temporary/noindex host.

Do not execute the old Brand #1 DNS, TLS, NPM, Merchant or rollback steps from Git history against La.na Design.

Repository configuration alone does **not** prove an external cutover. If production DNS/TLS/edge work is required, use the current project identity and record observed evidence for the exact deployment rather than reviving this superseded runbook.
