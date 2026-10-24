/**
 * Bank transfer as a website payment method.
 *
 * Off unless the owner has re-enabled it: master spec §14 says bank transfer is unavailable and that
 * no account detail or selectable method may be shown until then. So the switch is an environment
 * flag, and the account itself lives in the environment too, never in the repository -- a stored
 * account number is how a disabled method starts being usable again by accident.
 */

import { effectivePaymentMethod, parsePaymentMethod, type PaymentMethod } from "./payment-method.ts";
import { buildQrImage, buildVietQrPayload, type QrImage } from "./vietqr.ts";

export type BankTransferConfig = Readonly<{
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  /** The bank's six-digit NAPAS BIN; without it the confirmation page shows no QR. */
  bankBin: string | null;
  /** Placeholders: `{ORDER_ID}` (the POS order id) and `{PUBLIC_CODE}` (the code the buyer sees). */
  contentTemplate: string;
}>;

export { effectivePaymentMethod, parsePaymentMethod, type PaymentMethod };

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_CONTENT_TEMPLATE = "{ORDER_ID}";
const MAX_CONTENT_LENGTH = 50;
/** The longest values the placeholders can take: a safe-integer POS order id and a `LA-` code. */
const WORST_CASE_FACTS = Object.freeze({ orderId: "9".repeat(16), publicCode: "LA-ZZZZZZZZ" });

/**
 * The configured account, or `null` when bank transfer is off.
 *
 * A half-configured account is treated as off rather than thrown: checkout must keep taking COD
 * orders whatever state the transfer settings are in, and an incomplete account is never something
 * to show a buyer.
 */
export function readBankTransferConfig(env: Environment = process.env): BankTransferConfig | null {
  if (env.BANK_TRANSFER_ENABLED !== "true") return null;
  const bankName = env.BANK_TRANSFER_BANK_NAME?.trim();
  const accountNumber = env.BANK_TRANSFER_ACCOUNT_NUMBER?.trim();
  const accountHolder = env.BANK_TRANSFER_ACCOUNT_HOLDER?.trim();
  if (!bankName || !accountNumber || !accountHolder) return null;
  if (!/^[0-9]{6,19}$/.test(accountNumber)) return null;
  // A bad BIN only costs the QR: the account, amount and content are still shown as text.
  const rawBin = env.BANK_TRANSFER_BANK_BIN?.trim();
  const bankBin = rawBin && /^[0-9]{6}$/.test(rawBin) ? rawBin : null;
  const contentTemplate = env.BANK_TRANSFER_CONTENT_TEMPLATE?.trim() || DEFAULT_CONTENT_TEMPLATE;
  // The template is part of the account. One that cannot be rendered, can overflow the bank's limit,
  // or is the same text for every order would take transfers the shop cannot match to an order, so
  // it turns the method off here, at the gate in front of every order, not after one is placed.
  if (!isPerOrderTemplate(contentTemplate)) return null;
  return Object.freeze({ bankName, accountNumber, accountHolder, bankBin, contentTemplate });
}

function isPerOrderTemplate(template: string): boolean {
  if (!/\{(?:ORDER_ID|PUBLIC_CODE)\}/.test(template)) return false;
  return renderTransferContent(template, WORST_CASE_FACTS) !== null;
}

/**
 * The text the buyer must put in the transfer, from the owner's template.
 *
 * Returns `null` when it cannot be stated safely: any brace that is not part of a known placeholder
 * (an unknown or misspelled token, a lowercase one, an unclosed one), an empty result, or one longer
 * than the 50 characters most banks keep. A cut-off reference is worse than none, because
 * the transfer would arrive looking valid and match nothing.
 */
export function renderTransferContent(
  template: string,
  facts: Readonly<{ orderId: string; publicCode: string }>,
): string | null {
  // Whatever is left after the known tokens are removed must be free of braces: replacing only a
  // subset would let `{order_id}` or a stray `{` reach the buyer as literal text.
  if (/[{}]/.test(template.replace(/\{(?:ORDER_ID|PUBLIC_CODE)\}/g, ""))) return null;
  const rendered = template
    .replace(/\{ORDER_ID\}/g, facts.orderId)
    .replace(/\{PUBLIC_CODE\}/g, facts.publicCode)
    .trim();
  if (rendered.length === 0 || rendered.length > MAX_CONTENT_LENGTH) return null;
  return rendered;
}

export type BankTransferInstructions = Readonly<{
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  amountVnd: number;
  amountText: string;
  content: string;
  /** A scannable VietQR for exactly this account, amount and content, or null when one cannot be made. */
  qr: QrImage | null;
}>;

const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });

/**
 * What the confirmation page shows a buyer who chose bank transfer, or `null` when it cannot be shown
 * in full.
 *
 * The amount is the order's frozen total, never recomputed. Partial instructions are never shown:
 * an account without the content to put in the transfer, or without an amount, would let a buyer
 * pay money the shop cannot match to an order.
 */
export function buildBankTransferInstructions(
  config: BankTransferConfig | null,
  order: Readonly<{
    paymentMethod: PaymentMethod;
    publicCode: string;
    pancakeOrderId: string | null;
    totalVnd: bigint | null;
  }>,
): BankTransferInstructions | null {
  if (config === null || order.paymentMethod !== "BANK_TRANSFER") return null;
  if (order.pancakeOrderId === null || order.totalVnd === null) return null;
  const amountVnd = Number(order.totalVnd);
  if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0) return null;
  const content = renderTransferContent(config.contentTemplate, {
    orderId: order.pancakeOrderId,
    publicCode: order.publicCode,
  });
  if (content === null) return null;
  const payload =
    config.bankBin === null
      ? null
      : buildVietQrPayload({ bankBin: config.bankBin, accountNumber: config.accountNumber, amountVnd, content });
  return Object.freeze({
    bankName: config.bankName,
    accountNumber: config.accountNumber,
    accountHolder: config.accountHolder,
    amountVnd,
    amountText: currency.format(amountVnd),
    content,
    qr: payload === null ? null : buildQrImage(payload),
  });
}
