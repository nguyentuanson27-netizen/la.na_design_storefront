# Bank transfer checkout

Status: **implemented behind `BANK_TRANSFER_ENABLED`, off by default. Do not turn it on in production until the two gates below are closed.**

Master spec §14 and the policy authority still say bank transfer is unavailable on the website. This change adds the capability; it does not change that public statement. While the flag is off, checkout, the confirmation page and every policy page behave exactly as before.

## Gates before enabling

1. **Owner policy.** The owner re-approves bank transfer as a website payment method. Then update master spec §14, `FULFILLMENT.payment` (`src/brand/fulfillment.config.ts`) and the `/policies` and `/shipping` payment sections in the same change that sets the flag. Other copy still speaks of COD only and belongs in the same change: the lookup-order line in `src/content/public-brand-facts.ts` (pinned by `tests/domain/public-brand-content.test.ts`) and the in-form confirmation message in `src/commerce/checkout-submit-feedback.ts`. The `/track-order` header already says "đơn hàng".
2. **Live Pancake acceptance.** Place one real bank-transfer order and confirm in Pancake that:
   - the order is created with `cod = 0` ("Tiền thu hộ") and the `[CHUYỂN KHOẢN - chờ thanh toán]` note;
   - the transfer content Pancake generates (Cài đặt thanh toán → Nội dung chuyển khoản) equals what the confirmation page shows, so Pancake's automatic matching finds the transfer.

Acceptance has to show, not assume, that:

- Pancake receives the order in the type and status its transfer matching uses. Its "Quản lý giao dịch" documentation says money is matched only to orders waiting for a transfer, by amount and order code, while the partner banks' static QR matches by phone number. `cod: 0` alone does not say which. The create-order payload sets no payment method or status, so if the order does not arrive as waiting for a transfer, the mapping (or the allowed template) has to change.
- Matching uses the order code, not just the amount. Place two orders with the **same total** and different codes, make two transfers of that same amount each carrying its own content, then check each bank transaction ID against the Pancake order it settled: no swap. Two orders with different totals prove nothing, because a matcher that only reads the amount would pass. Repeat for every template the owner intends to use (especially `{PUBLIC_CODE}`), or restrict the allowed templates to what passed.

- The QR scans in the receiving bank's own app and pre-fills the right account, amount and content. Tests check that the payload is well formed with a valid checksum, and that an independent decoder (`jsqr`, a dev dependency) reads the rasterized QR back to the same bank BIN, account, amount and content. No bank app has been tried: on a real scan, also confirm the app shows the beneficiary name equal to `BANK_TRANSFER_ACCOUNT_HOLDER`.
- A transfer to the account shown on the website reaches Pancake. Pancake's "Đối tác" bank link describes syncing credits "theo tài khoản QR (không bao gồm tài khoản chính)", that is for QR accounts and not the main account. If the account number the website shows is the main account, Pancake may never see the money. In that case the website has to show the account Pancake issues its own QR for, or the shop reconciles by hand.

Keep `BANK_TRANSFER_ENABLED` off until all of these are shown.

The second point is open because the OpenAPI document does not define Pancake's `{FULL_ORDER_ID}` / `{DISPLAY_ID}` placeholders. The website renders `BANK_TRANSFER_CONTENT_TEMPLATE` from `{ORDER_ID}` (the id in the create-order response, stored as `pancakeOrderId`) and `{PUBLIC_CODE}`. Set Pancake's template to whatever renders the same text for a test order, then align the environment variable.

Recommendation: use a template with no customer name or phone (for example only the order id). Names lose diacritics, banks truncate content to about 50 characters, and a cut-off reference can match nothing.

## Configuration (server environment only)

| Variable | Meaning |
| --- | --- |
| `BANK_TRANSFER_ENABLED` | Must be exactly `true`. |
| `BANK_TRANSFER_BANK` | Code of a bank listed in `src/commerce/bank-transfer.ts` (currently `MB`). The name shown and the BIN in the QR come from the same row, so they cannot disagree; an unknown code turns the method off. Adding a bank means adding its row, with the BIN from the VietQR bank list, and a test. |
| `BANK_TRANSFER_ACCOUNT_NUMBER` | 6–19 digits. |
| `BANK_TRANSFER_ACCOUNT_HOLDER` | Shown to the buyer. |
| `BANK_TRANSFER_CONTENT_TEMPLATE` | Optional; defaults to `{ORDER_ID}`; at most 50 characters rendered. |

A half-configured account counts as off. No account detail is stored in the repository.

## Flow

1. Checkout shows a payment-method choice only when the loader reports the method as enabled. The server refuses `BANK_TRANSFER` itself when it is off, before spending a rate-limit attempt.
2. The snapshot stores `OrderMirror.paymentMethod` (`COD` by default).
3. The Pancake create-order request for a transfer order adds `cod: 0` and a note marker. COD requests are unchanged.
4. The confirmation page shows the bank, account, holder, the frozen order total and the transfer content, only when all of them can be stated in full. With a content of at most 25 plain characters, it also shows a VietQR for exactly that account, amount and content. The payload is built on the server (`src/commerce/vietqr.ts`, NAPAS 247 transfer to account) and drawn as inline SVG: nothing is sent to a QR service and no extra image origin is needed.
5. The shop confirms the order in Pancake once the transfer is matched. Pancake's own QR and auto-confirm settings are unaffected.

## Not in this change

- Reading Pancake's payment state back to show "đã thanh toán" on order tracking.
- Reminders or automatic cancellation for unpaid transfer orders.
