import Link from "next/link";

import { BRAND, NAVIGATION } from "@/brand";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="skip-link" href="#main-content">
        Bỏ qua đến nội dung chính
      </a>

      <div className="nav-shell">
        <Link className="brand-mark" href="/" aria-label={NAVIGATION.brandHomeLabel}>
          {BRAND.identity.displayNameUpper}
        </Link>

        <nav className="desktop-nav" aria-label="Điều hướng chính">
          {NAVIGATION.primary.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="mobile-nav">
          <details>
            <summary>Menu</summary>
            <nav className="mobile-menu" aria-label="Điều hướng chính trên di động">
              {[...NAVIGATION.primary, ...NAVIGATION.mobileUtility].map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </details>
        </div>

        <nav className="utility-nav" aria-label="Tiện ích">
          {NAVIGATION.utility.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
