# Storefront Virtual Try-on — Nano Banana Pro migration plan

Contract: [storefront-virtual-try-on.md](../docs/specs/storefront-virtual-try-on.md)
Operations: [vertex-virtual-try-on.md](../docs/integrations/vertex-virtual-try-on.md)

Owner decision, 2026-10-05: replace the dedicated Vertex `virtual-try-on-001` inference because
observed output quality is insufficient. Use Nano Banana Pro (`gemini-3-pro-image`) directly; do not
add a fallback chain.

## Dependency order

1. Amend the provider contract from current official Google Cloud docs.
2. Replace only the Vertex inference adapter; retain auth, timeout and trusted garment fetch.
3. Pin runtime location to `global` and fail closed on stale regional deployment config.
4. Update provider unit/integration tests and the hermetic Playwright fixture.
5. Run deterministic CI and review correctness/security.
6. Before enablement, run a controlled consented quality comparison on Áo dài / Set đồ / Váy-đầm.

## Intentionally unchanged

UI, category eligibility, exact first trusted product image authority, upload MIME/size contract,
age/likeness policy, guest/member quotas, concurrency controls, persistence behavior, cart/checkout
and the kill switch.
