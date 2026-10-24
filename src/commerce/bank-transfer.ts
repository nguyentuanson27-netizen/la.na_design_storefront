/**
 * Bank transfer as a website payment method.
 *
 * Off unless the owner has re-enabled it: master spec §14 says bank transfer is unavailable and that
 * no account detail or selectable method may be shown until then. So the switch is an environment
 * flag, and the account itself lives in the environment too, never in the repository -- a stored
 * account number is how a disabled method starts being usable again by accident.
 */

export type PaymentMethod = "COD" | "BANK_TRANSFER";

export type BankTransferConfig = Readonly<{
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  /** Placeholders: `{ORDER_ID}` (the POS order id) and `{PUBLIC_CODE}` (the code the buyer sees). */
  contentTemplate: string;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_CONTENT_TEMPLATE = "{ORDER_ID}";
const MAX_CONTENT_LENGTH = 50;

export function parsePaymentMethod(value: unknown): PaymentMethod | null {
  if (value === undefined || value === null || value === "" || value === "COD") return "COD";
  return value === "BANK_TRANSFER" ? "BANK_TRANSFER" : null;
}

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
  const contentTemplate = env.BANK_TRANSFER_CONTENT_TEMPLATE?.trim() || DEFAULT_CONTENT_TEMPLATE;
  return Object.freeze({ bankName, accountNumber, accountHolder, contentTemplate });
}

/**
 * The text the buyer must put in the transfer, from the owner's template.
 *
 * Returns `null` when it cannot be stated safely: an unknown placeholder, an empty result, or one
 * longer than the 50 characters most banks keep. A cut-off reference is worse than none, because
 * the transfer would arrive looking valid and match nothing.
 */
export function renderTransferContent(
  template: string,
  facts: Readonly<{ orderId: string; publicCode: string }>,
): string | null {
  let unknown = false;
  const rendered = template
    .replace(/\{([A-Z_]+)\}/g, (_match, name: string) => {
      if (name === "ORDER_ID") return facts.orderId;
      if (name === "PUBLIC_CODE") return facts.publicCode;
      unknown = true;
      return "";
    })
    .trim();
  if (unknown || rendered.length === 0 || rendered.length > MAX_CONTENT_LENGTH) return null;
  return rendered;
}

export type BankTransferInstructions = Readonly<{
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  amountVnd: number;
  amountText: string;
  content: string;
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
  return Object.freeze({
    bankName: config.bankName,
    accountNumber: config.accountNumber,
    accountHolder: config.accountHolder,
    amountVnd,
    amountText: currency.format(amountVnd),
    content,
  });
}
