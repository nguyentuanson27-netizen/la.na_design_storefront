import type { PrismaClient } from "../generated/prisma/client.ts";

import { createVoucherRedemptionService } from "./voucher-redemption-service.ts";

/**
 * Voucher v1 V14: the operator's way to return the vouchers of an order that was cancelled by a person (`ADMIN_CANCEL`).
 *
 * Used where no trusted automatic signal exists: staff cancelled the order by hand and Pancake did not report the cancelled
 * code (or has not been observed to). It is NOT money: orders are cash on delivery, so nothing is paid back; what returns is
 * the voucher's use and budget in the ledger. It is the same compare-and-set `refundOrder` every other signal uses, so it is
 * once-only and safe to repeat, and it stores the operator's evidence with the refund. Dry-run unless `apply` is given.
 */

export type AdminCancelArgs = Readonly<{ order: string; evidence: string; apply: boolean }>;

const ORDER = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** `--order <public code or id> --evidence "<who cancelled it, where, why>" [--apply]`; anything else is refused. */
export function parseAdminCancelArgs(argv: readonly string[]): AdminCancelArgs | null {
  let order: string | null = null;
  let evidence: string | null = null;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") { apply = true; continue; }
    const value = argv[index + 1];
    if ((flag !== "--order" && flag !== "--evidence") || value === undefined) return null;
    if (flag === "--order") { if (order !== null) return null; order = value; } else { if (evidence !== null) return null; evidence = value; }
    index += 1;
  }
  if (order === null || !ORDER.test(order)) return null;
  const trimmed = evidence?.trim() ?? "";
  if (trimmed.length < 10 || trimmed.length > 400 || CONTROL.test(trimmed)) return null;
  return { order, evidence: trimmed, apply };
}

export type AdminCancelResult =
  | Readonly<{ ok: true; applied: boolean; orderId: string; redemptions: readonly Readonly<{ kind: string; amountVnd: number; alreadyRefunded: boolean }>[]; refunded: number }>
  | Readonly<{ ok: false; reason: "ORDER_NOT_FOUND" | "NO_REDEMPTION" | "INVALID_EVIDENCE" | "NOT_A_TRUSTED_SIGNAL" }>;

export async function adminCancelVoucherOrder(client: PrismaClient, args: AdminCancelArgs): Promise<AdminCancelResult> {
  const order = await client.orderMirror.findFirst({ where: { OR: [{ id: args.order }, { publicCode: args.order }] }, select: { id: true } });
  if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
  const rows = await client.voucherRedemption.findMany({ where: { orderId: order.id }, orderBy: { kind: "asc" }, select: { kind: true, amountVnd: true, refundedAt: true } });
  if (rows.length === 0) return { ok: false, reason: "NO_REDEMPTION" };
  const redemptions = rows.map((row) => ({ kind: row.kind, amountVnd: Number(row.amountVnd), alreadyRefunded: row.refundedAt !== null }));
  if (!args.apply) return { ok: true, applied: false, orderId: order.id, redemptions, refunded: 0 };
  const refund = await createVoucherRedemptionService(client).refundOrder({ orderId: order.id, reason: "ADMIN_CANCEL", evidence: args.evidence });
  if (!refund.ok) return { ok: false, reason: refund.reason === "ORDER_NOT_FOUND" || refund.reason === "NO_REDEMPTION" || refund.reason === "INVALID_EVIDENCE" ? refund.reason : "NOT_A_TRUSTED_SIGNAL" };
  return { ok: true, applied: true, orderId: order.id, redemptions, refunded: refund.refunded };
}
