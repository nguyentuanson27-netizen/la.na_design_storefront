# Voucher v1 — H3-V browser evidence (AC-42 / AC-43 / TG-12)

- **Status:** local run **and CI run both green**; **H3-V waits only for the owner's sign-off** (see "Closing H3-V").
- **Code under test:** commit `68112c8db809a4cf1115157f29930aa75a346e35` (recorded in the evidence file). Run 2026-10-26, Node 22, Chromium (Desktop Chrome profile), PostgreSQL 16, **no Pancake call**.
- **Raw, sanitized evidence:** [`storefront-voucher-v1-h3v-browser-evidence.json`](./storefront-voucher-v1-h3v-browser-evidence.json). Re-run with `pnpm voucher:hold-harness` (needs `DATABASE_URL`, `BETTER_AUTH_SECRET`; CI job `voucher-hold-harness`).

## How it is built (and why it adds nothing to production)

| Piece | Where | Production footprint |
| --- | --- | --- |
| Test-only route (`/voucher-hold-harness`, a client button calling the **real** `holdStorefrontVouchers`) | `tests/fixtures/voucher-hold-harness/app` | None: outside `src/`, never imported, excluded from the image by `.dockerignore` |
| Runner | `scripts/voucher-hold-harness.ts` | None |
| Spec | `tests/a11y-runtime/voucher-hold-harness.spec.ts` (own config, not in the shared suite) | None |

The runner makes **two temporary git worktrees of the same commit**. The *official* one is built exactly as production is. The *test* one additionally receives the fixture route copied into its `src/app`, is built with `next build` and served with `next start`; Playwright drives it. Both worktrees are removed at the end; the test artifact is never kept or deployed.

No mock of the action, no CSRF bypass, no gate bypass, no rate-limit bypass, real PostgreSQL. Playwright **trace, video and screenshots are off** (a trace stores cookies, headers and response bodies, i.e. the cart cookie and the signed proof); the spec keeps its own log of method, path (no query), a coarse kind and status. The page shows the proof's *length*, never the proof. The evidence file was scanned: no cookie name or value, cart id, proof, secret, connection string or campaign/hold id.

## The official artifact is clean

| Check (all PASS) | Result |
| --- | --- |
| `server/app/voucher-hold-harness` exists in the official build | no |
| Harness route or `holdStorefrontVouchers` named in any of 7 manifests (`app-path-routes`, `routes`, `app-paths`, `build`, `prerender`, `server-reference`, `required-server-files`) | no occurrence |
| Executable output files (`.js/.json/.html/.rsc/…`, excluding file traces) naming the harness route / the hold action | 0 / 0 |
| `GET /voucher-hold-harness` and `/voucher-hold-harness/other` on the official server **with `LA_VOUCHER_TEST_HARNESS=true` in its environment** | **404 / 404** (and `/cart` → 200) |
| Positive controls on the test artifact: route in `app-path-routes-manifest.json`, hold action present with an id in `server-reference-manifest.json` | present (so the absences above are meaningful) |

The hold action is **not bundled at all** in the official build: nothing in `src/` imports it yet, so it is not even a callable action there. The first production reference will come with V18.

**Finding, disclosed rather than hidden:** three `.nft.json` *file-trace* lists (`api/try-on`, `api/product-image`, `shop/[slug]`) contain the harness **source file paths**. They list roughly 640 files under `tests/` plus docs, scripts and tasks — a pre-existing effect of dynamic `process.cwd()` paths — hold only paths (no code), and are not used by `next start`. The production image copies only `.next`, `package.json`, `next.config.mjs`, `public` and the Prisma client, and `.dockerignore` excludes `tests/`. The runner therefore reports them as information, not as a failure. If you want the paths gone too, adding `outputFileTracingExcludes` for `tests/**`, `docs/**`, `tasks/**` to `next.config.mjs` would do it; I have not changed production config.

## What the browser run proved (production build, real action)

| Scenario | Proof |
| --- | --- |
| **AC-42** GET, RSC render, `<Link>` prefetch, hover, reload, client navigation, back/forward | 3 documents, **87 RSC prefetches observed** (not a vacuous pass), 4 navigations; **0 requests carried the hold action id**; 0 non-GET requests other than the layout's own read-only cart actions (3, a different action id); database before = after, **byte for byte**, including the campaign row's `updatedAt`; 0 holds |
| **AC-43** one click | exactly **1** hold POST and **1** hold (`HELD`, 50.000 VND); `expiresAt − createdAt` = **600 000 ms** exactly; the UI shows the stored `expiresAt`; `reservedUses` 1 |
| **AC-43** double-click, second tab, reload, back/forward | 2 more POSTs on double-click and 1 from the second tab all answered from the **same** hold: still 1 hold, **same `expiresAt`**, ledger unchanged; navigation afterwards sends **0** further hold POSTs and changes nothing |
| **CSRF** the same POST replayed with `Origin: https://evil.example` | refused by Next (HTTP 500), **0 holds**; the identical request with the real origin → 200 and 1 hold (so the request was well formed and only the origin check stopped it) |
| **AC-34** another tab switches to a *different voucher of equal value* | same total shown (880 000), different digest; click → `QUOTE_CHANGED`, **0 holds, 0 reserved**; after reload the refreshed quote holds the voucher now shown |
| **AC-34** a quote that raises the total (shipping 0 → 30 000) | without acknowledgement → `CONFIRMATION_REQUIRED`, **0 holds**; acknowledged → exactly 1 hold, total 120 000 |
| **Proof failure** a legitimate cart at the line limit (50 products × 2 units, long variation ids, every line split in two price segments ⇒ 100 signed lines, past the 16 KiB proof envelope) | the real action answers `PROOF_UNAVAILABLE`, **0 holds, 0 reserved**; a different buyer then takes the only use (`maxUses` 1) |

## What this does not show

- Chromium on the Desktop Chrome profile only; no Firefox/WebKit, no real device, no `Link` prefetch under a slow network.
- A single-origin local run: the CSRF proof is Next's Origin/Host check, not a cross-site browser attack with cookies set `SameSite=Lax`.
- The harness page is not the cart, the picker or checkout. It proves the action and the GET/prefetch behaviour of a route that renders the same quote; V18's real UI still needs its own run of this script with its button.
- Preview/hold mismatch found on the way: a voucher can be **offered** in the preview for a cart whose signed proof would exceed the 16 KiB envelope, and the hold then fails closed with `PROOF_UNAVAILABLE`. Safe (nothing is reserved) but a poor experience; the feasibility seam should exclude such a candidate before it is shown. Tracked for V18.
- The layout's own read-only server actions (cart view/lines) run on page load; they are recorded separately and hold nothing.

## CI

GitHub Actions run `40268151627` on commit `05a031c0598482b688b6328cce3d88004585743b`: **19 of 19 check runs succeeded**, including the new `voucher-hold-harness` job (runner `ubuntu-latest`, PostgreSQL 16 service, `next build` ×2 + `next start`, Playwright Chromium), `verify`, `verify-runtime`, `verify-db-shard-2`, four `admin-a11y-runtime` shards and the container/QA workflows. The job's log shows every official-artifact check, the three positive controls and `playwright: every voucher-hold scenario passed — exit 0`, followed by the same sanitized evidence JSON (no cookie, proof or secret).

An earlier push (`0096cee`) never ran CI at all: its `ci.yml` was invalid (the `runner` context is not available in job-level `env`), so GitHub started no jobs. That is fixed in `05a031c`; the later commits only change documentation.

## Closing H3-V

H3-V closes when all of: (1) this evidence — **done**; (2) CI green on the head commit — **done on `05a031c`** (re-confirm on the final head if code changes again); (3) the owner signs off on the evidence — **pending**. Until the sign-off V13 stays blocked.
