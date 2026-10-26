# Voucher v1 — H1-V POS probe evidence

- **Gate:** H1-V (exact-money write/readback), plan task V09. Authorised by the repository owner on 2026-10-26 ("H1-V: cho phép").
- **Run:** `pnpm pancake:voucher:accept` (`scripts/pancake-voucher-acceptance.ts`), run id `h1v1026`, 2026-10-26T02:43Z, through a Claude Code session.
- **Shop:** `715077776` — the same owner-approved shop and the same clearly marked test variation (`9e7a1103-6e08-4580-be46-41678726f1dd`, SKU `SQ069S`, stock 5 before the run) as the gift-quantity evidence in [`pancake-gift-quantity-acceptance.md`](../integrations/pancake-gift-quantity-acceptance.md). This is **not** a separate sandbox shop; the run is bounded by the test variation, the fixed `TEST … KHONG GIAO` customer, one create per case and cancellation of every order.
- **Safety model:** refuses CI; needs `GQ_POS_PROBE_APPROVED=shop:<id>`; the fixtures are derived by the production allocation (V02) and projection (V09) and compared with pinned literals **before** anything is sent; one create per case, never retried; each order cancelled and read back; no key and no customer data in the report. Offline coverage: `tests/domain/pancake-voucher-acceptance.test.ts` (6 tests, fake POS).

## Result: 4 of 4 PASS, `noOrderMayBeOpen: true`

| Fixture | Lines sent = lines read back (not merged) | Order total read back | POS order | Status open → after cancel |
| --- | --- | --- | --- | --- |
| F1 — 3 × 100.000đ, voucher 10.000đ | 2 × 96.667đ + 1 × 96.666đ | 290.000đ (= expected) | 5 | 0 → 7 |
| F2 — one variation on two website lines, voucher 50.000đ | 1 × 275.000đ + 2 × 137.500đ | 550.000đ | 6 | 0 → 7 |
| F3 — voucher 80.000đ then 1 gift (1.000đ carved from paid units) | 219.231đ, 218.231đ, 131.538đ, 1.000đ (1 unit each) | 570.000đ | 7 | 0 → 7 |
| F4 — 2 × 2đ + 1 × 1.000đ, voucher 1.000đ | 1 × 2đ + 2 × 1đ | 4đ | 8 | 0 → 7 |

F5 (infeasible) writes nothing by design; it is covered offline (AC-20 / TG-02).

## What this establishes

- The POS stores and returns voucher-derived line prices **exactly**, including three distinct prices of one variation in one order, 1đ unit prices, and a 1.000đ gift-offset line. The order total (`total_price`, merchandise only) equals the website's paid subtotal to the VND. This is the H1-V condition for V12.
- **TG-04 status evidence:** a newly created order reads `status 0`; after `PUT … {status: 7}` it reads `status 7` (the production comparison reports "the POS order is canceled"). This matches the gift-quantity runs (orders 1–4). It is evidence for the *cancel we issue ourselves*; a cancel made by staff inside Pancake, other terminal statuses, and whether the status moves on its own are **not** shown here, so V14's trusted-cancel mapping still needs its own evidence.
- The four test orders (ids 5–8) are cancelled. Stock was not otherwise touched.

## What it does not establish

- Behaviour at a different shop: the shop must still be listed in `LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS` (ADR 0019) before any hold is granted, and a new shop needs its own run.
- Customer-visible acceptance of the order (H3-V), refund on cancel (V14), or any checkout use of vouchers (V18). `LA_VOUCHER_ENABLED` stays unset in production.
