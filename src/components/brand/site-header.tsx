import Link from "next/link";

import { BRAND, NAVIGATION, type NavigationLink } from "@/brand";

type HierarchicalNavigationLink = NavigationLink & Readonly<{
  children?: readonly HierarchicalNavigationLink[];
}>;

export function SiteHeader() {
  const primary = NAVIGATION.primary as readonly HierarchicalNavigationLink[];

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
          {primary.map((item) => (
            <div key={item.href}>
              <Link href={item.href}>{item.label}</Link>
              {item.children?.length ? (
                <div>
                  {item.children.map((child) => (
                    <Link key={child.href} href={child.href}>{child.label}</Link>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </nav>

        <div className="mobile-nav">
          <details>
            <summary>Menu</summary>
            <nav className="mobile-menu" aria-label="Điều hướng chính trên di động">
              {primary.map((item) => (
                <div key={item.href}>
                  <Link href={item.href}>{item.label}</Link>
                  {item.children?.map((child) => (
                    <Link key={child.href} href={child.href}>{child.label}</Link>
                  ))}
                </div>
              ))}
              {NAVIGATION.mobileUtility.map((item) => (
                <Link key={item.href} href={item.href}>{item.label}</Link>
              ))}
            </nav>
          </details>
        </div>

        <nav className="utility-nav" aria-label="Tiện ích">
          {NAVIGATION.utility.map((item) => (
            <Link key={item.href} href={item.href}>{item.label}</Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
