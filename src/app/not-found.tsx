import Link from "next/link";
import { BRAND } from "@/brand";

// U30 / W14a. Next answers 404 for an unmatched route on its own; what it answers *with* is an
// unbranded default page with no way back. This is the route-level recovery surface: it keeps the
// 404 status (rendering it must never turn the response into a soft 200 or a redirect to the
// homepage) and offers the visitor the same destinations the site header already names, so a
// mistyped or expired URL ends in a choice rather than a dead end.
const RECOVERY_DESTINATIONS = [
  { href: "/", label: "Trang chủ" },
  { href: "/shop", label: "Cửa hàng" },
  { href: "/collections", label: "Bộ sưu tập" },
  { href: "/search", label: "Tìm kiếm" },
] as const;

export default function NotFound() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <section aria-labelledby="not-found-title" className="ui-state">
        <p className="eyebrow">{BRAND.identity.name} / 404</p>
        <h1 id="not-found-title" className="ui-state__title">
          Không tìm thấy trang
        </h1>
        <p className="ui-state__copy">
          Trang bạn tìm không tồn tại. Đường dẫn có thể đã được nhập sai hoặc không còn được dùng.
        </p>
        <nav className="mt-8 flex flex-wrap gap-x-8 gap-y-4" aria-label="Điều hướng thay thế">
          {RECOVERY_DESTINATIONS.map((destination) => (
            <Link className="text-link" key={destination.href} href={destination.href}>
              {destination.label} <span aria-hidden="true">↗</span>
            </Link>
          ))}
        </nav>
      </section>
    </div>
  );
}
