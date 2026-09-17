"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { BRAND, NAVIGATION, type NavigationLink } from "@/brand";
import { CartDrawer } from "@/components/brand/cart-drawer";
import { SearchOverlay } from "@/components/brand/search-overlay";
import type { SiteHeaderModel } from "@/components/headless/site-chrome-model";
import { useAccountAuth } from "@/components/headless/use-account-auth";

type HierarchicalNavigationLink = NavigationLink & Readonly<{
  key?: string;
  children?: readonly HierarchicalNavigationLink[];
}>;

function UtilityIcon({ href }: { href: string }) {
  if (href === "/search") {
    return (
      <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.6" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16" y2="16" />
      </svg>
    );
  }
  if (href === "/account") {
    return (
      <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.6" aria-hidden="true">
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    );
  }
  if (href === "/cart") {
    return (
      <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.6" aria-hidden="true">
        <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
        <line x1="3" y1="6" x2="21" y2="6" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </svg>
    );
  }
  return null;
}

export function SiteHeader({ model }: Readonly<{ model?: SiteHeaderModel }>) {
  const pathname = usePathname();
  const { session } = useAccountAuth();
  const [isScrolled, setIsScrolled] = useState(false);
  const [activeMegaMenu, setActiveMegaMenu] = useState<string | null>(null);
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const headerRef = useRef<HTMLElement | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cartTriggerRef = useRef<HTMLButtonElement | null>(null);

  const loginPath = ["", "login"].join("/");
  const primary = NAVIGATION.primary as readonly HierarchicalNavigationLink[];
  const mobileUtility = NAVIGATION.mobileUtility;

  const closeCartDrawer = () => setCartDrawerOpen(false);
  const openSearch = () => setSearchOpen(true);
  const closeSearch = () => setSearchOpen(false);

  // Track scroll position for transparent -> cream transition
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Close menus on route change
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setActiveMegaMenu(null);
  }

  // Handle escape key to dismiss open menus
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setActiveMegaMenu(null);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const getMegaMedia = (item: HierarchicalNavigationLink) => {
    if (!model?.megaMedia || !item.key) return null;
    return model.megaMedia.find((m) => m.categoryKey === item.key) ?? null;
  };

  return (
    <header
      ref={headerRef}
      className={`site-header sticky top-0 z-40 transition-colors duration-300 ${
        isScrolled
          ? "bg-[#FAF7F2]/95 backdrop-blur-md border-b border-[#3B2219]/15 shadow-sm"
          : "bg-[#FAF7F2] md:bg-transparent border-b border-[#3B2219]/10"
      }`}
    >
      <a className="skip-link" href="#main-content">
        Bỏ qua đến nội dung chính
      </a>

      <div className="nav-shell">
        <Link className="brand-mark" href="/" aria-label={NAVIGATION.brandHomeLabel}>
          {BRAND.identity.displayNameUpper}
        </Link>

        {/* Desktop Primary Navigation */}
        <nav className="desktop-nav" aria-label="Điều hướng chính">
          {primary.map((item, index) => {
            const hasChildren = item.children && item.children.length > 0;
            const isMegaOpen = activeMegaMenu === item.href;
            const media = getMegaMedia(item);
            const isSaleItem = index === primary.length - 1;

            return (
              <div
                key={item.href}
                className="relative"
                onMouseEnter={() => hasChildren && setActiveMegaMenu(item.href)}
                onMouseLeave={() => hasChildren && setActiveMegaMenu(null)}
              >
                <div className="flex items-center gap-1">
                  <Link
                    href={item.href}
                    className={`py-2 transition-colors hover:text-[#2A1810] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3B2219] ${
                      isSaleItem ? "text-amber-800 font-semibold" : ""
                    }`}
                  >
                    {item.label}
                  </Link>
                  {hasChildren ? (
                    <button
                      type="button"
                      aria-expanded={isMegaOpen}
                      aria-haspopup="true"
                      aria-label={item.label}
                      onClick={() => setActiveMegaMenu(isMegaOpen ? null : item.href)}
                      className="inline-flex h-6 w-5 items-center justify-center text-[#3B2219]/60 hover:text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
                    >
                      <svg
                        className={`h-3.5 w-3.5 transition-transform duration-200 ${isMegaOpen ? "rotate-180" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  ) : null}
                </div>

                {/* Mega Menu Dropdown */}
                {hasChildren && isMegaOpen ? (
                  <div
                    role="region"
                    aria-label={item.label}
                    className="absolute left-1/2 -translate-x-1/2 top-full z-50 mt-1 w-[560px] lg:w-[680px] rounded-b-lg border border-[#3B2219]/15 bg-[#FAF7F2] p-6 shadow-xl"
                  >
                    <div className="grid grid-cols-2 gap-8 items-start">
                      <div>
                        <p className="eyebrow text-[#70584B] mb-3">{item.label}</p>
                        <ul className="space-y-2.5">
                          {item.children!.map((child) => (
                            <li key={child.href}>
                              <Link
                                href={child.href}
                                className="block text-sm font-normal normal-case tracking-normal text-[#3B2219] hover:text-[#2A1810] hover:underline underline-offset-4 transition"
                              >
                                {child.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                        <div className="mt-5 border-t border-[#3B2219]/15 pt-3">
                          <Link
                            href={item.href}
                            className="inline-flex items-center text-xs font-semibold uppercase tracking-wider text-[#3B2219] hover:text-[#2A1810] hover:underline underline-offset-4"
                          >
                            {item.label}
                          </Link>
                        </div>
                      </div>

                      {/* Editorial Media Container */}
                      <div className="relative aspect-[4/5] overflow-hidden rounded-sm bg-[#3B2219]/5">
                        {media ? (
                          <Image
                            src={media.imageUrl}
                            alt={media.altText || item.label}
                            fill
                            sizes="300px"
                            className="object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full flex-col justify-end p-4 bg-gradient-to-t from-[#2A1810]/70 to-transparent">
                            <span className="font-serif text-lg text-white font-medium">
                              {item.label}
                            </span>
                            <span className="text-xs text-white/80 tracking-wider uppercase mt-1">
                              {BRAND.identity.displayNameUpper}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        {/* Mobile Navigation */}
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
              {mobileUtility.map((item) => {
                const destination = item.href === "/account" ? (session ? item.href : loginPath) : item.href;
                return (
                  <Link key={item.href} href={destination}>{item.label}</Link>
                );
              })}
            </nav>
          </details>
        </div>

        {/* Utility Navigation */}
        <nav className="utility-nav" aria-label="Tiện ích">
          {NAVIGATION.utility.map((item, index) => {
            const isSearch = index === 0;
            const isAccount = index === 1;
            const isCart = index === 2;
            const destination = isAccount && !session ? loginPath : item.href;

            if (isSearch) {
              return (
                <button
                  key={item.href}
                  ref={searchTriggerRef}
                  type="button"
                  onClick={openSearch}
                  aria-label={item.label}
                  aria-haspopup="dialog"
                >
                  <UtilityIcon href={item.href} />
                  <span className="sr-only">{item.label}</span>
                </button>
              );
            }

            if (isCart) {
              return (
                <button
                  key={item.href}
                  ref={cartTriggerRef}
                  type="button"
                  onClick={() => setCartDrawerOpen(true)}
                  aria-label={item.label}
                  aria-haspopup="dialog"
                >
                  <UtilityIcon href={item.href} />
                  <span className="sr-only">{item.label}</span>
                </button>
              );
            }

            return (
              <Link
                key={item.href}
                href={destination}
                aria-label={item.label}
              >
                <UtilityIcon href={item.href} />
                <span className="sr-only">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Cart Drawer */}
      <CartDrawer
        isOpen={cartDrawerOpen}
        onClose={closeCartDrawer}
        triggerRef={cartTriggerRef}
      />

      {/* Full-Screen Search Overlay */}
      <SearchOverlay
        isOpen={searchOpen}
        onClose={closeSearch}
        triggerRef={searchTriggerRef}
      />
    </header>
  );
}
