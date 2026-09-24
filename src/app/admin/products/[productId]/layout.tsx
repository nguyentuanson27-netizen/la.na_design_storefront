import Link from "next/link";
import { notFound } from "next/navigation";

import { requireCurrentAdminPage } from "@/auth/current-admin";
import { PRODUCT_CONTENT_LIMITS } from "@/commerce/product-content-admin";
import { prisma } from "@/db/prisma";

type ProductEditorLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ productId: string }>;
};

export default async function ProductEditorLayout({
  children,
  params,
}: ProductEditorLayoutProps) {
  const { productId } = await params;
  if (
    productId.length === 0 ||
    productId.length > PRODUCT_CONTENT_LIMITS.productId ||
    productId !== productId.trim()
  ) {
    notFound();
  }

  await requireCurrentAdminPage();

  const incomingCompositeVariants = await prisma.variantMirror.findMany({
    where: {
      productId,
      compositeParents: { some: {} },
    },
    orderBy: [{ color: "asc" }, { size: "asc" }, { id: "asc" }],
    select: {
      id: true,
      sku: true,
      color: true,
      size: true,
      compositeParents: {
        orderBy: [{ parentVariantId: "asc" }],
        select: {
          quantity: true,
          parentVariant: {
            select: {
              id: true,
              sku: true,
              color: true,
              size: true,
              product: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return (
    <>
      {children}
      {incomingCompositeVariants.length > 0 ? (
        <section
          aria-labelledby="incoming-composite-references-heading"
          className="mx-auto mt-8 max-w-6xl border border-black/20 bg-black/[0.02] p-6 md:p-8"
        >
          <p className="eyebrow">Pancake composite · chỉ đọc</p>
          <h2
            id="incoming-composite-references-heading"
            className="mt-1 font-display text-3xl tracking-[-0.03em]"
          >
            Sản phẩm set đang tham chiếu
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-black/70">
            Các quan hệ dưới đây đọc từ composite mirror đã đồng bộ. Kích hoạt biến thể được quản lý
            ở bảng Biến thể website; cấu thành set vẫn chỉ chỉnh trong Pancake.
          </p>

          <div className="mt-6 space-y-5">
            {incomingCompositeVariants.map((variant) => {
              const variantLabel =
                variant.sku ||
                [variant.color, variant.size].filter(Boolean).join(" / ") ||
                variant.id;

              return (
                <div className="border-t border-black/15 pt-4" key={variant.id}>
                  <p className="font-mono text-xs font-semibold">Biến thể: {variantLabel}</p>
                  <ul className="mt-3 space-y-2 text-sm">
                    {variant.compositeParents.map(({ parentVariant, quantity }) => {
                      const parentVariantLabel =
                        parentVariant.sku ||
                        [parentVariant.color, parentVariant.size].filter(Boolean).join(" / ") ||
                        parentVariant.id;

                      return (
                        <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1" key={parentVariant.id}>
                          <Link
                            className="font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
                            href={`/admin/products/${parentVariant.product.id}`}
                          >
                            {parentVariant.product.name}
                          </Link>
                          <span className="text-black/70">
                            · {parentVariantLabel} · ×{quantity}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}
