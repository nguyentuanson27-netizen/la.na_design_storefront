import Link from "next/link";

import { BRAND } from "@/brand";

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <section className="admin-shell min-h-[70vh] px-6 py-10 md:px-10 md:py-14">
      <header className="mb-12 flex flex-col gap-6 border-b border-black/20 pb-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="eyebrow">{BRAND.identity.name} / Admin</p>
          <p className="mt-2 max-w-2xl font-display text-xl leading-relaxed">
            Quản lý phần nội dung biên tập do website sở hữu, tách biệt khỏi dữ liệu vận hành của Pancake POS.
          </p>
        </div>
        <nav aria-label="Điều hướng quản trị" className="flex flex-wrap gap-x-6 gap-y-3 text-xs font-semibold uppercase tracking-[0.14em]">
          <Link className="border-b border-black pb-1 focus-visible:outline-2 focus-visible:outline-offset-4" href="/admin">
            Sản phẩm
          </Link>
          <Link className="border-b border-black/30 pb-1 focus-visible:outline-2 focus-visible:outline-offset-4" href="/admin/collections">
            Collections
          </Link>
          <Link className="border-b border-black/30 pb-1 focus-visible:outline-2 focus-visible:outline-offset-4" href="/admin/promotions">
            Khuyến mãi
          </Link>
          <Link className="border-b border-black/30 pb-1 focus-visible:outline-2 focus-visible:outline-offset-4" href="/">
            Xem cửa hàng
          </Link>
        </nav>
      </header>
      {children}
    </section>
  );
}
