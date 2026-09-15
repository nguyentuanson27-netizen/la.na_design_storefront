# LA Clothing

Editorial men's fashion ecommerce storefront with Pancake POS integration.

## Stack

- Next.js 16.2.11 / React 19.2 / TypeScript
- Tailwind CSS v4
- PostgreSQL + Prisma 7.9.1
- Better Auth
- Pancake POS adapter under `src/integrations/pancake/`
- pnpm 11.4.0 on Node.js 22+

## Local commands

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm dev
```

Quality gates:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm build
pnpm release:check
```

`pnpm prisma:migrate:deploy` applies checked-in production migrations.

## Architecture — what a fork rewrites, and what it must not touch

This repository is a storefront **core kit**: a brand fork rewrites the presentation and keeps
everything else. Phase G's discardability exercise measured that claim by redrawing all nineteen
pages and the brand components from scratch — 26 presentation files changed, **0 shared-layer
files** (`docs/phase-g-notes.md`).

**Yours to rewrite per brand**

- `src/app/**/page.tsx` — markup over a view model
- `src/app/globals.css`
- `src/components/brand/**`
- `src/brand/*.config.ts` — Brand Config (identity, contact, navigation, fulfillment, size guide)

**Shared: not a fork's presentation surface**

Everything outside the surfaces above stays shared. In particular: `src/routes` (loaders, view
models, metadata builders, the route shell), `src/components/headless` (decisions without markup),
`src/components/commerce` (shared checkout/tracking workflows), `src/commerce`, `src/seo`, `src/db`,
`src/auth`, `src/integrations`, `src/tracking`, `src/content`, `prisma`, `scripts`, `.github`.

### The page boundary

A module under `src/app` may import from exactly **five internal roots**:

```
src/app   src/routes   src/brand   src/components/brand   src/components/headless
```

and from an **exact external allowlist** — `react`, `react-dom`, `next`, `next/image`, `next/link`.
Exact means exact: allowing `next` does not also allow `next/server`, `next/headers`, `next/cache` or
`next/navigation`. Request/server-state APIs belong below the page seam; `next/navigation` is also
outside the approved page allowlist.

`tests/domain/route-boundary.test.ts` enforces this against the repository. It enumerates every
`.ts`/`.tsx` under `src/app` except `admin/**`, and holds every page-layer module to the policy.
Server endpoints and the root layout are exempt on the terms spec 04 §8.1 sets — route handlers and
`sitemap.ts` by filename at any depth, `robots.ts` and `layout.tsx` by exact path at the app root.

Each route also renders through `createStorefrontRoute`, which mounts promotion refresh, the
commerce event, JSON-LD and Meta pixel events unconditionally, so a page cannot drop one by
forgetting. `tests/domain/route-manifest.test.ts` traces the default export back to the factory.

### Bootstrap a new brand

```bash
pnpm bootstrap:brand
```

Reads `project.config.json`, writes `.env.local` from `.env.example`, and renames the social-card
route directory to the project slug. Then edit `src/brand/*.config.ts` and redraw the surfaces above.

### `LA_*` environment variables

The `LA_` prefix is this template's own namespace for storefront policy that is deployment
configuration rather than code: shipping (`LA_SHIPPING_FEE_VND`,
`LA_FREE_SHIPPING_SUBTOTAL_VND`, `LA_FREE_SHIPPING_MIN_QUANTITY`), tracking (`LA_TRACKING_MODE`,
`LA_BUILD_FACEBOOK_PIXEL_ID`, `LA_GTM_CONTAINER_ID`), merchant feed
(`LA_MERCHANT_TARGET_COUNTRY`, `LA_MERCHANT_CONTENT_LANGUAGE`, `LA_MERCHANT_CURRENCY`) and
`LA_PROMOTION_ACTIVATION_ENABLED`. A fork keeps the prefix: it is read by name in
`src/operations` and in the CI workflows, so renaming it is a code change, not a configuration one.
`deploy/vps/env.example` carries placeholders for six of these — the shipping and merchant-feed
values. The four tracking/promotion ones (`LA_TRACKING_MODE`, `LA_BUILD_FACEBOOK_PIXEL_ID`,
`LA_GTM_CONTAINER_ID`, `LA_PROMOTION_ACTIVATION_ENABLED`) are read by the app but absent from the
template, so an operator deploying from it gets their defaults without being told they exist. See
`docs/phase-g-notes.md` §3.3.

### Approved spec and runbook

The contracts above are owned by the `webtemplate` spec repository, not by this one. Implementation
may be narrower than a spec only after the spec says so — never by widening a contract in a code
comment.

- Route shell and page boundary — [spec 04](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/04-lop-2-route-shell.md) (§6.3 policy, §8.1 gate scope)
- Brand Config — [spec 05](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/05-lop-3-brand-config.md)
- Headless UI — [spec 06](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/06-lop-4-headless-ui.md)
- Buyer-language tests — [spec 07](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/07-lop-5-test-ngon-ngu.md)
- Out of scope — [spec 10](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/10-ranh-gioi-khong-lam.md)
- New-shop runbook — [runbook 08](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/08-runbook-shop-moi.md)

Phase notes in `docs/phase-*-notes.md` record what each phase decided and what it left open.

## Production deployment

The active production architecture is a self-managed VPS using Docker Compose with Next.js, PostgreSQL, and Caddy.

Repository deployment assets live under `deploy/vps/`:

- `env.example` — placeholder-only production configuration template;
- `compose.yml` — app/PostgreSQL/Caddy/ops topology;
- `Caddyfile` — TLS reverse proxy and trusted client-IP boundary;
- `deploy.sh` — exact-SHA preflight, backup, migration, promotion, and health flow;
- `rollback.sh` — application-image rollback only.

See:

- `docs/decisions/0002-vps-production-infrastructure.md`
- `docs/operations/vps-bootstrap.md`
- `docs/operations/release-and-rollback.md`

Production secrets and VPS credentials must never be committed to this repository.
