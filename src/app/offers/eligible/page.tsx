import Link from "next/link";
import Image from "next/image";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { readAuthServerConfig } from "@/auth/config";
import { createPromotionUpsellService } from "@/commerce/promotion-upsell";
import { upsellReadGate } from "@/commerce/checkout-upsell-read-gate";
import { deriveGuestCheckoutClientKey } from "@/commerce/guest-checkout-client-identity";
import { createGuestCheckoutRateLimiter } from "@/commerce/guest-checkout-rate-limit";
import { isPromotionUpsellEnabled } from "@/commerce/promotion-upsell-policy";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ campaign?: string | string[] }> };

export default async function EligibleOfferProducts({ searchParams }: Props) {
  await connection();
  const { campaign } = await searchParams;
  const campaignId = typeof campaign === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(campaign)
    ? campaign : null;
  let offer: Awaited<ReturnType<ReturnType<typeof createPromotionUpsellService>["getBrowse"]>> = null;
  let limited = false;
  if (campaignId) {
    // An optional GET must have the same resource protections as the checkout POST.
    // Acquire before hitting the DB; neither a queue nor a failure can block COD checkout.
    const release = upsellReadGate.tryAcquire();
    if (!release) {
      limited = true;
    } else {
      try {
        const auth = readAuthServerConfig();
        const shopId = readPancakeShopId();
        if (isPromotionUpsellEnabled(shopId)) {
          const clientKey = deriveGuestCheckoutClientKey(await headers(), auth);
          // Shared across instances and with POST /api/checkout/upsell: 20 attempts/minute
          // per trusted client, independent of the geo and checkout-submit buckets.
          if (!(await createGuestCheckoutRateLimiter(prisma).consumeUpsellClient({ clientKey }))) {
            limited = true;
          } else {
            offer = await createPromotionUpsellService(prisma, await cookies(), {
              shopId, secret: auth.secret,
            }).getBrowse(campaignId);
          }
        }
      } catch {
        // Fail closed on invalid identity, unavailable limiter or quote failure.
      } finally {
        release();
      }
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <Link href="/checkout" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
        Quay lại thanh toán
      </Link>
      <h1 className="mt-4 font-display text-3xl leading-tight">Sản phẩm áp dụng ưu đãi</h1>
      {offer ? (
        <>
          <p className="mt-3 text-sm leading-6 text-black/70">
            {offer.offerName}. Những mẫu dưới đây có phiên bản đã được kiểm tra theo giỏ hàng hiện tại.
            Giá, tồn kho và quyền nhận ưu đãi sẽ được tính lại khi nàng thêm vào giỏ.
          </p>
          <ul className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {offer.products.map((product) => (
              <li key={product.slug} className="min-w-0 border border-black/15 p-4">
                <Link href={`/shop/${encodeURIComponent(product.slug)}`} className="block focus-visible:outline-2 focus-visible:outline-offset-2">
                  {product.imageUrl ? (
                    <Image src={product.imageUrl} width={320} height={400} alt="" className="aspect-[4/5] w-full object-cover" />
                  ) : <div className="aspect-[4/5] w-full bg-black/5" aria-hidden="true" />}
                  <h2 className="mt-3 break-words text-base font-semibold">{product.name}</h2>
                  <span className="mt-2 inline-block text-sm underline underline-offset-4">Xem sản phẩm</span>
                </Link>
                <p className="mt-2 break-words text-xs leading-5 text-black/70">Phiên bản phù hợp: {product.options.join(", ")}</p>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="mt-7 border border-black/15 p-5">
          <p className="text-sm leading-6">{limited ? "Gợi ý ưu đãi đang có quá nhiều lượt truy cập. Nàng thử lại sau ít phút nhé." : "Ưu đãi hoặc giỏ hàng đã thay đổi, hiện không có sản phẩm phù hợp được xác nhận."}</p>
          <Link href="/shop" className="mt-3 inline-flex min-h-11 items-center text-sm underline">Xem tất cả sản phẩm</Link>
        </div>
      )}
    </main>
  );
}
