import Link from "next/link";
import { cookies } from "next/headers";

import { readAnonymousCartCookie } from "@/commerce/anonymous-cart-cookie";
import { readCartOwnVoucherHolds } from "@/commerce/voucher-own-holds";
import { readVoucherPreview } from "@/commerce/voucher-preview";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

import { HoldButtons } from "./hold-buttons";

/**
 * TEST HARNESS ONLY (tests/fixtures/voucher-hold-harness). Not part of `src/`.
 *
 * A plain GET render of the quote a cart or checkout page would show: it reads, it never writes. The only thing on
 * this page that can create a hold is the button below, which POSTs the real Server Action.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function VoucherHoldHarnessPage() {
  const cartId = readAnonymousCartCookie(await cookies());
  const preview =
    cartId === null
      ? null
      : await readVoucherPreview({ client: prisma, cartId, shopId: readPancakeShopId(), now: new Date(), ownHolds: await readCartOwnVoucherHolds(prisma, cartId) });
  const quote = preview !== null && preview.enabled && preview.ok ? preview.quote : null;
  const digest = preview !== null && preview.enabled && preview.ok ? preview.quoteDigest ?? "" : "";
  return (
    <main data-harness="voucher-hold">
      <h1>Voucher hold harness</h1>
      <p data-testid="total">{quote === null ? "none" : String(quote.totalPayableVnd)}</p>
      <p data-testid="selection">{quote === null ? "" : JSON.stringify(quote.selection)}</p>
      <nav>
        <Link href="/voucher-hold-harness/other" prefetch data-testid="link-other">
          Other page (prefetched)
        </Link>
        <span data-testid="hover-target" tabIndex={0}>
          hover me
        </span>
      </nav>
      <HoldButtons digest={digest} />
    </main>
  );
}
