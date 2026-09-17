"use client";

import { useEffect, useState, useRef, useId, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { BRAND, NAVIGATION, type NavigationLink } from "@/brand";
import type { SiteHeaderModel } from "@/components/headless/site-chrome-model";

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
  const [isScrolled, setIsScrolled] = useState(false);
  const [activeMegaMenu, setActiveMegaMenu] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [expandedMobileItem, setExpandedMobileItem] = useState<string | null>(null);

  const headerRef = useRef<HTMLElement | null>(null);
  const mobileNavId = useId();

  const primary = NAVIGATION.primary as readonly HierarchicalNavigationLink[];
  const utility = NAVIGATION.utility;
  const mobileUtility = NAVIGATION.mobileUtility;
  const cartItem = utility.find((item) => item.href === "/cart");

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
  useEffect(() => {
    setActiveMegaMenu(null);
    setMobileMenuOpen(false);
  }, [pathname]);

  // Handle escape key to dismiss open menus
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setActiveMegaMenu(null);
      setMobileMenuOpen(false);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [mobileMenuOpen]);

  const toggleMobileMenu = () => setMobileMenuOpen(!mobileMenuOpen);

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

      {/* Desktop & Mobile Main Nav Shell */}
      <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3.5 sm:px-6 md:py-4">
        {/* Mobile Header: Left Hamburger Button */}
        <div className="flex items-center md:hidden">
          <button
            type="button"
            aria-label={mobileMenuOpen ? "Đóng menu" : "Mở menu"}
            aria-expanded={mobileMenuOpen}
            aria-controls={mobileNavId}
            onClick={toggleMobileMenu}
            className="inline-flex h-10 w-10 items-center justify-center text-[#3B2219] hover:text-[#2A1810] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
          >
            {mobileMenuOpen ? (
              <svg className="h-6 w-6 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg className="h-6 w-6 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" aria-hidden="true">
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
        </div>

        {/* Brand Mark (Desktop Left, Mobile Center) */}
        <div className="flex justify-center md:justify-start">
          <Link
            className="brand-mark font-serif text-xl sm:text-2xl font-bold tracking-wider text-[#2A1810] transition-opacity hover:opacity-85"
            href="/"
            aria-label={NAVIGATION.brandHomeLabel}
          >
            {BRAND.identity.displayNameUpper}
          </Link>
        </div>

        {/* Desktop Primary Navigation */}
        <nav
          className="desktop-nav hidden md:flex items-center gap-7 lg:gap-9 text-[0.8rem] font-medium tracking-[0.1em] uppercase text-[#3B2219]"
          aria-label="Điều hướng chính"
        >
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

        {/* Desktop Utility Icons (Search, Account, Cart) */}
        <div className="utility-nav hidden md:flex items-center gap-3 sm:gap-4 md:gap-5 text-[#3B2219]">
          {utility.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-[#3B2219]/10 transition-colors focus-visible:outline-2 focus-visible:outline-[#3B2219]"
            >
              <UtilityIcon href={item.href} />
            </Link>
          ))}
        </div>

        {/* Mobile Header: Right Cart Link */}
        <div className="flex items-center md:hidden">
          {cartItem ? (
            <Link
              href={cartItem.href}
              aria-label={cartItem.label}
              className="inline-flex h-10 w-10 items-center justify-center text-[#3B2219] hover:text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
            >
              <UtilityIcon href={cartItem.href} />
            </Link>
          ) : null}
        </div>
      </div>

      {/* Full-Screen Mobile Navigation Overlay */}
      {mobileMenuOpen ? (
        <div
          id={mobileNavId}
          role="dialog"
          aria-modal="true"
          aria-label="Điều hướng chính trên di động"
          className="fixed inset-0 top-[57px] z-50 flex flex-col justify-between bg-[#FAF7F2] p-6 overflow-y-auto md:hidden"
        >
          <div className="space-y-6">
            <nav aria-label="Danh mục trên di động" className="space-y-2">
              {primary.map((item, index) => {
                const hasChildren = item.children && item.children.length > 0;
                const isExpanded = expandedMobileItem === item.href;
                const isSaleItem = index === primary.length - 1;

                return (
                  <div key={item.href} className="border-b border-[#3B2219]/10 pb-2">
                    <div className="flex items-center justify-between">
                      <Link
                        href={item.href}
                        className={`font-serif text-xl tracking-tight text-[#2A1810] hover:text-stone-600 ${
                          isSaleItem ? "text-amber-800" : ""
                        }`}
                      >
                        {item.label}
                      </Link>
                      {hasChildren ? (
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          aria-label={item.label}
                          onClick={() => setExpandedMobileItem(isExpanded ? null : item.href)}
                          className="p-2 text-[#3B2219]/70 hover:text-[#2A1810]"
                        >
                          <svg
                            className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
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

                    {/* Expandable Subcategories */}
                    {hasChildren && isExpanded ? (
                      <ul className="mt-2 pl-4 space-y-2 border-l-2 border-[#3B2219]/20">
                        {item.children!.map((child) => (
                          <li key={child.href}>
                            <Link
                              href={child.href}
                              className="block py-1 text-sm text-[#3B2219] hover:text-[#2A1810]"
                            >
                              {child.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </nav>

            {/* Mobile Utility Links */}
            <div className="space-y-3 pt-4">
              <p className="eyebrow text-[#70584B]">Tiện ích</p>
              <div className="flex flex-col space-y-2 text-sm text-[#3B2219]">
                {mobileUtility.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="inline-flex items-center gap-3 py-1 hover:text-[#2A1810]"
                  >
                    <UtilityIcon href={item.href} />
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {/* Contact footer in mobile drawer */}
          <div className="mt-8 border-t border-[#3B2219]/15 pt-4 text-xs text-[#3B2219]/70 space-y-1">
            <p>Hotline: {BRAND.contact.telephone}</p>
            <p>Email: {BRAND.contact.email}</p>
            <p className="text-[0.68rem] text-[#3B2219]/50 mt-2">
              © {BRAND.identity.name}
            </p>
          </div>
        </div>
      ) : null}
    </header>
  );
}
