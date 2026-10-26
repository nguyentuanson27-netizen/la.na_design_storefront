# Voucher v1 — H3-V browser evidence (AC-42 / AC-43 / TG-12)

- **Status:** the second H3-V review re-opened the gate (two P1 in the flow logic); both are fixed with regression tests, the browser evidence was re-run on the fixed code, and **CI is green on `37f6de3`** (the last commit with code changes). **the owner approved H3-V on 2026-10-26.**
- **Code under test:** commit `bc0229264a15962d41961b48277eac5025e22a50` (recorded in the evidence file; re-run after the second review fixes). Run 2026-10-26, Node 22, Chromium (Desktop Chrome profile), PostgreSQL 16, **no Pancake call**.
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
| Executable output files (`.js/.json/.html/.rsc/…`, excluding file traces) naming the harness route / the hold action | 0 / 0 **at the time of H3-V** (see the V18 note below) |
| `GET /voucher-hold-harness` and `/voucher-hold-harness/other` on the official server **with `LA_VOUCHER_TEST_HARNESS=true` in its environment** | **404 / 404** (and `/cart` → 200) |
| Positive controls on the test artifact: route in `app-path-routes-manifest.json`, hold action present with an id in `server-reference-manifest.json` | present (so the absences above are meaningful) |

The hold action was **not bundled at all** in the official build when H3-V was recorded: nothing in `src/` imported it. **V18 (2026-10-26) adds the first production caller, the checkout panel's hold button**, so the official build now contains the action by design and the harness check was changed from "action absent" to a positive control "action present for checkout". The harness route is still absent (404 even with `LA_VOUCHER_TEST_HARNESS=true`), and a hold still needs one deliberate POST: `checkout-voucher.spec.ts` shows no hold row exists until the button is pressed.

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

GitHub Actions run `40270628144` on commit `37f6de37b94e9bf6ea1ec8641a797e8fa5a79ef9` (the last commit that changes code; later commits only touch documentation): **19 of 19 check runs succeeded**, including `voucher-hold-harness` (PostgreSQL 16 service, `next build` ×2 + `next start`, Playwright Chromium), `verify`, `verify-runtime`, the DB shard, all four `admin-a11y-runtime` shards and the container/QA workflows. The harness job's log shows every official-artifact check, the three positive controls and `playwright: every voucher-hold scenario passed — exit 0`, followed by the same sanitized evidence JSON.

History, for the record: an earlier push (`0096cee`) started no CI at all because my `ci.yml` was invalid (the `runner` context is not available in job-level `env`), fixed in `05a031c`. On the docs-only `5d3f357` the `voucher-picker` AC-13 browser test failed on both attempts; it was a real picker bug, not a flake (applying a private code refreshed the page, the re-keyed picker remounted and closed the open dialog) and was fixed in `37f6de3`.

## Closing H3-V

**Closed 2026-10-26: approved by the owner ("duyệt h3v").** All three conditions are met: (1) this evidence; (2) CI green on the head commit — `37f6de3` (19/19), and again on `6e75c2a` (19/19) after the last test-robustness fix; (3) the owner's sign-off. The approval covers V11–V12 and AC-42/43 only. It does **not** approve V13, V18, merging PR #214 or enabling vouchers / a verified shop in production. Gates that stay with the later tasks: V13 must prove the voucher HELD proof and the checkout/gift proof stay consistent (gift A→B at the same count), accepted/consume once and stock-failure rollback; V18 must run this script's browser scenarios on the real cart/checkout and handle the UX of a voucher that is offered but whose proof would exceed 16 KiB.

## Second review (2026-10-26) — what changed and what was re-run

Two P1 were found after the evidence above was recorded: a stale tab could release a hold through the "no voucher" branch (no digest compared), and a selection saved by another tab between the preview and the grant was not detected (the transaction checked only `paidRevision`). Both are fixed in the flow (digest for every outcome; the quote is recomputed under the cart lock inside the hold transaction) and covered by deterministic tests with a barrier between the preview read and the grant (`tests/database/voucher-hold-flow.test.ts`: A→B of equal value, A→none, a price moving, the stale-tab NONE release, the NONE→AUTO flip, and a service test proving the hook runs with the cart row locked). Mutations (no recompute, NONE released before the digest, hook before the lock) each fail a test. Because the flow code changed, the browser harness and its evidence file were **re-run on the new commit**; the figures above are from that re-run (see the commit named in the evidence file).
