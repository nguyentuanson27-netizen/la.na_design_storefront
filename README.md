# La.na Design Storefront

Official B2C storefront for **La.na Design**, a Vietnamese women’s fashion brand, with Pancake POS integration.

## Stack

- Next.js 16.2.11 / React 19.2 / TypeScript
- Tailwind CSS v4
- PostgreSQL + Prisma 7.9.1
- Better Auth
- Pancake POS adapter under `src/integrations/pancake/`
- pnpm 11.4.0 on Node.js 22+

## Local development

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

## Current project identity

Committed deployment identity lives in `project.config.json`:

- project slug: `la-na-design`
- database: `la_na_design`
- Compose project: `la-na-design`
- production domain: `www.lanadesign.vn`

Brand, legal, contact, taxonomy, size-guide and fulfillment truth belongs under `src/brand/` and must trace back to the approved repository authorities below. Pancake remains the external commerce integration; inherited LA Clothing copy is not an authority for this storefront.

## Documentation authority

Use these documents for current La.na Design work:

- [`docs/specs/la-na-design-master-spec.md`](docs/specs/la-na-design-master-spec.md) — consolidated implementation contract and precedence rules.
- [`docs/specs/la-na-design-owner-approved-facts-and-decisions.md`](docs/specs/la-na-design-owner-approved-facts-and-decisions.md) — field-level owner-approved brand facts.
- [`docs/specs/la-na-design-policy-authority.md`](docs/specs/la-na-design-policy-authority.md) — approved policy wording owned by the website.
- [`tasks/plan.md`](tasks/plan.md) and [`tasks/todo.md`](tasks/todo.md) — current execution plan and checklist.
- [`docs/decisions/`](docs/decisions/) — ADR history. Newer ADRs supersede older decisions where stated; old ADRs are retained rather than rewritten.

### Legacy LA Clothing material

This repository was forked from the storefront Core Kit / Brand #1 history, so older phase notes, audits, task plans and ADRs can still mention LA Clothing, its old domains or its old production environment. Those files are **historical technical evidence only** unless a current La.na Design document explicitly adopts their contract.

The former LA Clothing spec/fact/reconciliation paths are kept only as short tombstones so old links fail safely instead of presenting Brand #1 truth as current truth. Git history remains the archive for their original contents.

## Architecture boundaries

The storefront keeps the Core Kit separation between brand presentation and shared commerce/integration layers:

- `src/brand/` — current La.na Design brand and policy configuration.
- `src/app/` + `src/components/brand/` — storefront presentation.
- `src/routes/` — route loaders, view models and metadata builders.
- `src/commerce/` — shared commerce policy and orchestration.
- `src/integrations/pancake/` — raw Pancake API boundary.
- `prisma/` — database schema and migrations.

`tests/domain/route-boundary.test.ts` and related architecture tests enforce the page/import boundary. Prefer extending the existing owners instead of duplicating brand facts or Pancake behavior in presentation code.

## Production deployment

The active production architecture is a self-managed VPS using Docker Compose with Next.js, PostgreSQL and Caddy.

Repository deployment assets live under `deploy/vps/`:

- `env.example` — placeholder-only production configuration template;
- `compose.yml` — app/PostgreSQL/Caddy/ops topology;
- `Caddyfile` — TLS reverse proxy and trusted client-IP boundary;
- `deploy.sh` — exact-SHA preflight, backup, migration, promotion and health flow;
- `rollback.sh` — application-image rollback only.

Operational references:

- `docs/decisions/0002-vps-production-infrastructure.md`
- `docs/operations/vps-bootstrap.md`
- `docs/operations/release-and-rollback.md`

Production secrets and VPS credentials must never be committed to this repository.
