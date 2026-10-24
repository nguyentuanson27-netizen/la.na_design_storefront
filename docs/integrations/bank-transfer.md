# Bank transfer checkout

Status: **implemented behind `BANK_TRANSFER_ENABLED`, off by default. Do not turn it on in production until the two gates below are closed.**

Master spec §14 and the policy authority still say bank transfer is unavailable on the website. This change adds the capability; it does not change that public statement. While the flag is off, checkout, the confirmation page and every policy page behave exactly as before.

## Gates before enabling

1. **Owner policy.** The owner re-approves bank transfer as a website payment method. Then update master spec §14, `FULFILLMENT.payment` (`src/brand/fulfillment.config.ts`) and the `/policies` and `/shipping` payment sections in the same change that sets the flag.
2. **Live Pancake acceptance.** Place one real bank-transfer order and confirm in Pancake that:
   - the order is created with `cod = 0` ("Tiền thu hộ") and the `[CHUYỂN KHOẢN - chờ thanh toán]` note;
   - the transfer content Pancake generates (Cài đặt thanh toán → Nội dung chuyển khoản) equals what the confirmation page shows, so Pancake's automatic matching finds the transfer.

The second point is open because the OpenAPI document does not define Pancake's `{FULL_ORDER_ID}` / `{DISPLAY_ID}` placeholders. The website renders `BANK_TRANSFER_CONTENT_TEMPLATE` from `{ORDER_ID}` (the id in the create-order response, stored as `pancakeOrderId`) and `{PUBLIC_CODE}`. Set Pancake's template to whatever renders the same text for a test order, then align the environment variable.

Recommendation: use a template with no customer name or phone (for example only the order id). Names lose diacritics, banks truncate content to about 50 characters, and a cut-off reference can match nothing.

## Configuration (server environment only)

| Variable | Meaning |
| --- | --- |
| `BANK_TRANSFER_ENABLED` | Must be exactly `true`. |
| `BANK_TRANSFER_BANK_NAME` | Shown to the buyer. |
| `BANK_TRANSFER_ACCOUNT_NUMBER` | 6–19 digits. |
| `BANK_TRANSFER_ACCOUNT_HOLDER` | Shown to the buyer. |
| `BANK_TRANSFER_CONTENT_TEMPLATE` | Optional; defaults to `{ORDER_ID}`; at most 50 characters rendered. |

A half-configured account counts as off. No account detail is stored in the repository.

## Flow

1. Checkout shows a payment-method choice only when the loader reports the method as enabled. The server refuses `BANK_TRANSFER` itself when it is off, before spending a rate-limit attempt.
2. The snapshot stores `OrderMirror.paymentMethod` (`COD` by default).
3. The Pancake create-order request for a transfer order adds `cod: 0` and a note marker. COD requests are unchanged.
4. The confirmation page shows the bank, account, holder, the frozen order total and the transfer content, only when all of them can be stated in full.
5. The shop confirms the order in Pancake once the transfer is matched. Pancake's own QR and auto-confirm settings are unaffected.

## Not in this change

- A VietQR image on the confirmation page (needs a CSP `img-src` entry or a local QR encoder).
- Reading Pancake's payment state back to show "đã thanh toán" on order tracking.
- Reminders or automatic cancellation for unpaid transfer orders.
