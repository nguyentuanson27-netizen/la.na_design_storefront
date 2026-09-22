"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { BRAND, NAVIGATION, type NavigationLink } from "@/brand";
import { CartDrawer } from "@/components/brand/cart-drawer";
import { SearchOverlay } from "@/components/brand/search-overlay";
import { handleDrawerFocusTrap } from "@/components/headless/cart-drawer-model";
import { STOREFRONT_CART_DRAWER_OPEN_EVENT } from "@/components/headless/cart-drawer-events";
import { useScrollLock } from "@/components/headless/use-scroll-lock";
import type { SiteHeaderModel } from "@/components/headless/site-chrome-model";
import { useAccountAuth } from "@/components/headless/use-account-auth";

/**
 * The owner-approved master logo, committed byte-for-byte under `public/brand`. It is the same
 * asset the footer renders; the header simply draws it smaller. Replacing the wordmark is a swap of
 * this one file, not an edit spread across two chrome surfaces.
 */
const BRAND_MASTER_LOGO_SRC = "/brand/la-na-design-master-logo.png";

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
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  // One open category at a time: the point of collapsing the subcategories is that the whole
  // menu stays short enough to scan without scrolling, which two open groups already undo.
  const [expandedMobileGroup, setExpandedMobileGroup] = useState<string | null>(null);

  const headerRef = useRef<HTMLElement | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeSearchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cartTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavCloseRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavDrawerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedBeforeMobileNav = useRef<HTMLElement | null>(null);
  const wasMobileNavOpenRef = useRef(false);

  const loginPath = ["", "login"].join("/");
  const primary = NAVIGATION.primary as readonly HierarchicalNavigationLink[];
  const mobileUtility = NAVIGATION.mobileUtility;

  const closeCartDrawer = () => setCartDrawerOpen(false);

  useEffect(() => {
    const openRequestedCart = () => setCartDrawerOpen(true);
    window.addEventListener(STOREFRONT_CART_DRAWER_OPEN_EVENT, openRequestedCart);
    return () => window.removeEventListener(STOREFRONT_CART_DRAWER_OPEN_EVENT, openRequestedCart);
  }, []);

  const openSearch = (trigger?: HTMLButtonElement | null) => {
    activeSearchTriggerRef.current = trigger ?? searchTriggerRef.current;
    setSearchOpen(true);
  };
  const closeSearch = () => setSearchOpen(false);

  const openMobileNav = () => {
    previouslyFocusedBeforeMobileNav.current = document.activeElement as HTMLElement | null;
    setExpandedMobileGroup(null);
    setIsMobileNavOpen(true);
  };
  const closeMobileNav = () => {
    setIsMobileNavOpen(false);
  };

  const handleOpenMobileSearch = () => {
    closeMobileNav();
    openSearch(mobileNavTriggerRef.current);
  };

  // Holds the page still behind the menu; see the note in `useScrollLock` for why body alone is
  // not enough on this site.
  useScrollLock(isMobileNavOpen);

  // Focus restoration for the full-screen mobile nav.
  useEffect(() => {
    if (isMobileNavOpen) {
      wasMobileNavOpenRef.current = true;
      const timer = setTimeout(() => {
        mobileNavCloseRef.current?.focus();
      }, 50);
      return () => {
        clearTimeout(timer);
      };
    } else if (wasMobileNavOpenRef.current) {
      wasMobileNavOpenRef.current = false;
      if (!searchOpen) {
        const returnTarget = previouslyFocusedBeforeMobileNav.current ?? mobileNavTriggerRef.current;
        returnTarget?.focus?.();
      }
    }
  }, [isMobileNavOpen, searchOpen]);

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
    if (isMobileNavOpen) {
      setIsMobileNavOpen(false);
    }
  }

  // Handle escape key to dismiss open menus, and tab to trap focus in mobile nav
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isMobileNavOpen) {
          event.preventDefault();
          setIsMobileNavOpen(false);
        }
        setActiveMegaMenu(null);
      } else if (event.key === "Tab" && isMobileNavOpen) {
        handleDrawerFocusTrap(event, mobileNavDrawerRef.current);
      }
    },
    [isMobileNavOpen],
  );

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
      data-scrolled={isScrolled ? "true" : "false"}
      className={`site-header sticky top-0 z-40 transition-colors duration-300 ${
        isScrolled
          ? "bg-[#FAF7F2]/95 backdrop-blur-md border-b border-[#3B2219]/15 shadow-sm"
          : "bg-[#FAF7F2] border-b border-[#3B2219]/10"
      }`}
    >
      <a className="skip-link" href="#main-content">
        Bỏ qua đến nội dung chính
      </a>

      <div className="nav-shell">
        {/* Mobile Hamburger Trigger (visible on mobile, positioned on the left) */}
        <div className="mobile-nav">
          <button
            ref={mobileNavTriggerRef}
            type="button"
            onClick={openMobileNav}
            aria-expanded={isMobileNavOpen}
            aria-haspopup="dialog"
            aria-controls="mobile-navigation-dialog"
            aria-label="Menu"
            className="inline-flex h-11 w-11 items-center justify-center text-[#3B2219] hover:text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
          >
            <svg
              className="h-5 w-5 stroke-current"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="18" x2="20" y2="18" />
            </svg>
            <span className="sr-only">Menu</span>
          </button>
        </div>

        {/* Brand Logo (centered on mobile, left on desktop). The approved master logo ships with a
            transparent background, so it sits on the cream header and on the scrolled/blurred
            header without a plate behind it. The link keeps its own accessible name, so the image
            stays decorative rather than announcing the wordmark twice. */}
        <Link className="brand-mark" href="/" aria-label={NAVIGATION.brandHomeLabel}>
          <Image
            className="brand-mark-logo"
            src={BRAND_MASTER_LOGO_SRC}
            alt=""
            width={4185}
            height={2148}
            sizes="176px"
            priority
          />
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
                      className="inline-flex h-6 w-5 items-center justify-center text-[#70584B] hover:text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
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
                  onClick={() => openSearch(searchTriggerRef.current)}
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
                className={isAccount ? "mobile-account-link" : undefined}
              >
                <UtilityIcon href={item.href} />
                <span className="sr-only">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Render outside the scrolled header so backdrop-filter can never become the
          containing block for this fixed viewport dialog. The portal changes only physical DOM
          placement; refs, state, React events and focus management stay owned by SiteHeader. */}
      {isMobileNavOpen
        ? createPortal(
            <div
          id="mobile-navigation-dialog"
          ref={mobileNavDrawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Menu điều hướng"
          className="mobile-nav-dialog fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-[#FAF7F2]"
        >
          {/* Mobile Header Bar inside full-screen menu: Logo + Close Button */}
          <div className="mobile-nav-dialog__bar">
            <Image
              className="brand-mark-logo"
              src={BRAND_MASTER_LOGO_SRC}
              alt={BRAND.identity.name}
              width={4185}
              height={2148}
              sizes="176px"
            />
            <button
              ref={mobileNavCloseRef}
              type="button"
              onClick={closeMobileNav}
              aria-label="Đóng menu"
              className="inline-flex h-11 w-11 items-center justify-center text-[#3B2219] hover:text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
            >
              <svg
                className="h-6 w-6 stroke-current"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              <span className="sr-only">Đóng menu</span>
            </button>
          </div>

          {/* Primary Mobile Navigation Links */}
          <nav className="mobile-menu flex-1" aria-label="Điều hướng chính trên di động">
            <ul className="mobile-menu__list">
              {primary.map((item) => {
                const hasChildren = item.children && item.children.length > 0;
                const panelId = `mobile-nav-panel${item.href.replaceAll("/", "-")}`;
                const isExpanded = expandedMobileGroup === item.href;
                return (
                  <li key={item.href} className="mobile-menu__item">
                    <div className="mobile-menu__row">
                      {/* The category stays a link: collapsing its children must not cost the
                          category page its one route into the catalogue. The disclosure is a
                          separate control beside it, so a tap either navigates or expands and
                          never guesses which was meant. */}
                      <Link
                        href={item.href}
                        onClick={closeMobileNav}
                        className="mobile-menu__link"
                      >
                        {item.label}
                      </Link>
                      {hasChildren ? (
                        <button
                          type="button"
                          className="mobile-menu__disclosure"
                          aria-expanded={isExpanded}
                          aria-controls={panelId}
                          aria-label={`${isExpanded ? "Thu gọn" : "Mở rộng"} ${item.label}`}
                          onClick={() => setExpandedMobileGroup(isExpanded ? null : item.href)}
                        >
                          <svg
                            className={`mobile-menu__chevron${isExpanded ? " mobile-menu__chevron--open" : ""}`}
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
                    {hasChildren ? (
                      <ul id={panelId} className="mobile-menu__sublist" hidden={!isExpanded}>
                        {item.children!.map((child) => (
                          <li key={child.href}>
                            <Link
                              href={child.href}
                              onClick={closeMobileNav}
                              className="mobile-menu__sublink"
                            >
                              {child.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {/* Mobile Utility Links */}
            <ul className="mobile-menu__utility">
              {mobileUtility.map((item) => {
                if (item.href === "/search") {
                  return (
                    <li key={item.href}>
                      <button
                        type="button"
                        onClick={handleOpenMobileSearch}
                        aria-haspopup="dialog"
                        className="mobile-menu__utility-link"
                      >
                        {item.label}
                      </button>
                    </li>
                  );
                }
                const destination = item.href === "/account" ? (session ? item.href : loginPath) : item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={destination}
                      onClick={closeMobileNav}
                      className="mobile-menu__utility-link"
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
            </div>,
            document.body,
          )
        : null}

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
        triggerRef={activeSearchTriggerRef}
      />
    </header>
  );
}
