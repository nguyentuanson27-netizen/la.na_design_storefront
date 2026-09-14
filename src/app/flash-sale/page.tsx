import Link from "next/link";

import { BRAND } from "@/brand";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { createStorefrontRoute } from "@/routes/factory";
import { loadFlashSaleRoute, type FlashSaleRouteProps } from "@/routes/flash-sale";
import type { FlashSaleViewModel } from "@/routes/flash-sale-model";
import {
  buildFlashSaleMetadata,
  FLASH_DESCRIPTION,
  FLASH_TITLE,
} from "@/routes/metadata/flash-sale";

/** Markup only. The window, its products and the refresh boundary live in `@/routes/flash-sale`. */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

function render(data: FlashSaleViewModel) {
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-10 md:py-16">
      <header>
        <p className="eyebrow">{BRAND.identity.name} / Khuyến mãi</p>
        <h1 className="mt-5 text-[clamp(2.8rem,6vw,6.5rem)] font-semibold leading-[0.9] tracking-[-0.045em]">
          {FLASH_TITLE}
        </h1>
        <p className="mt-6 max-w-xl text-sm leading-6 text-black/65">{FLASH_DESCRIPTION}</p>
      </header>

      <section aria-labelledby="flash-sale-results" className="mt-12 border-t border-black/20 pt-8">
        <h2 id="flash-sale-results" className="sr-only">
          Sản phẩm đang giảm giá
        </h2>

        <p aria-live="polite" className="text-xs uppercase tracking-[0.14em] text-black/55">
          {data.totalCount === 0
            ? "Hiện chưa có sản phẩm nào trong khung giờ Flash Sale."
            : `${data.totalCount} sản phẩm đang giảm giá`}
        </p>

        {data.cards.length > 0 ? (
          <div className="product-grid mt-8">
            {data.cards.map((card, index) => (
              <ProductCard
                key={card.id}
                model={card.model}
                tone={tones[(data.toneOffset + index) % tones.length]!}
              />
            ))}
          </div>
        ) : (
          <p className="mt-8 max-w-xl text-sm leading-6 text-black/70">
            Hãy quay lại sau — trang này tự cập nhật khi khung giờ Flash Sale bắt đầu.{" "}
            <Link className="underline" href="/shop">
              Xem toàn bộ cửa hàng
            </Link>
            .
          </p>
        )}

        {data.totalPages > 1 ? (
          <nav
            aria-label="Phân trang Flash Sale"
            className="mt-12 flex items-center justify-between gap-4 border-t border-black/20 pt-6"
          >
            {data.previousHref ? (
              <Link className="underline" href={data.previousHref}>
                Trang trước
              </Link>
            ) : (
              <span aria-hidden="true" />
            )}
            <p className="text-xs uppercase tracking-[0.14em] text-black/55">
              Trang {data.page} / {data.totalPages}
            </p>
            {data.nextHref ? (
              <Link className="underline" href={data.nextHref}>
                Trang sau
              </Link>
            ) : (
              <span aria-hidden="true" />
            )}
          </nav>
        ) : null}
      </section>
    </div>
  );
}

const route = createStorefrontRoute<FlashSaleRouteProps, FlashSaleViewModel>({
  load: loadFlashSaleRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildFlashSaleMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
