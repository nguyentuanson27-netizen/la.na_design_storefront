# Voucher hold browser harness (H3-V, AC-42 / AC-43)

**This is test-only code and it is never part of the production source tree.** Nothing under
`tests/fixtures/voucher-hold-harness/app` is imported by `src/`, copied by a build script, or reachable from the
official build. `scripts/voucher-hold-harness.ts` copies the route into a **temporary git worktree** of the commit
under test, builds that worktree with `next build`, serves it with `next start`, drives it with Playwright and then
deletes the worktree. The artifact it produces is never deployed.

The same script also builds the commit **without** the harness (the shape production is built in) and proves that
the official artifact contains no harness route and no reference to the hold action, and that the harness URL
answers 404 even when `LA_VOUCHER_TEST_HARNESS=true` is set in its environment.

What the route does: a server component renders the picker digest (a plain GET, the way a cart or checkout would),
a client component calls the **real** Server Action `holdStorefrontVouchers`. No mock, no CSRF bypass, no gate
bypass, real PostgreSQL, no Pancake call. It never renders the proof, a cookie or a secret.

Run: `pnpm voucher:hold-harness` (needs `DATABASE_URL` and `BETTER_AUTH_SECRET`; see the script header).
