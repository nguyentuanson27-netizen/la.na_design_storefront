"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Below-`lg` compaction for the PDP's reading blocks.
 *
 * On a phone the product information and delivery/returns facts stack under the purchase panel.
 * The description starts fully visible; the material, shipping and returns disclosures start open,
 * while other sections may retain their collapsed default. Shoppers can still collapse them.
 * From `lg` up nothing changes: every block is drawn open and no toggle is rendered.
 *
 * Both are CSS-first (`hidden lg:block`) so the server-rendered page has no layout shift and the
 * desktop composition never waits on script. The content itself stays server-rendered children.
 */

const HEADING = "font-display text-xl font-normal tracking-[-0.02em] lg:text-2xl";

function Chevron({ open }: Readonly<{ open: boolean }>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * One block that is a disclosure below `lg` and a plain titled section from `lg` up.
 *
 * Two headings carry the same words: the phone one wraps the toggle, the desktop one is static. Only
 * one is ever displayed, so the accessibility tree and the visible page both hold exactly one.
 */
export function PdpDisclosure({
  titleId,
  title,
  children,
  initiallyOpen = false,
}: Readonly<{
  /** The desktop heading's id; the section is named by it on every viewport. */
  titleId: string;
  title: string;
  children: ReactNode;
  /** Initial mobile state; desktop content is always visible. */
  initiallyOpen?: boolean;
}>) {
  const [open, setOpen] = useState(initiallyOpen);
  const panelId = useId();

  return (
    <section className="border-b border-[#3B2219]/25 lg:py-6" aria-labelledby={titleId}>
      <h2 id={titleId} className={`pdp-section-title hidden lg:block ${HEADING}`}>
        {title}
      </h2>
      <h2 className={`lg:hidden ${HEADING}`}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          className="flex min-h-14 w-full items-center justify-between gap-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
          onClick={() => setOpen((current) => !current)}
        >
          {title}
          <Chevron open={open} />
        </button>
      </h2>
      <div id={panelId} className={`${open ? "block" : "hidden"} pb-6 lg:block lg:pb-0`}>
        {children}
      </div>
    </section>
  );
}

/**
 * Product description starts fully expanded, including on phones.
 *
 * Long descriptions still offer "Thu gọn" / "Xem thêm"; short ones have no redundant toggle.
 * Measure against the 9rem mobile clamp even while expanded, then remeasure on resize.
 */
export function PdpClampedContent({ children }: Readonly<{ children: ReactNode }>) {
  const [expanded, setExpanded] = useState(true);
  const [overflows, setOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const contentId = useId();

  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const measure = () => {
      // Tailwind's max-h-36 below is 9rem, irrespective of whether it is currently applied.
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      setOverflows(content.scrollHeight > 9 * rem + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const clamped = !expanded;

  return (
    <>
      <div
        ref={contentRef}
        id={contentId}
        data-clamped={clamped && overflows ? "true" : "false"}
        className={`pdp-clamped relative ${clamped ? "max-h-36 overflow-hidden" : ""} lg:max-h-none lg:overflow-visible`}
      >
        {children}
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-2 inline-flex min-h-11 items-center text-sm text-[#3B2219] underline decoration-[#3B2219]/30 underline-offset-[5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3B2219] lg:hidden"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Thu gọn" : "Xem thêm"}
        </button>
      ) : null}
    </>
  );
}
