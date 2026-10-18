"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Below-`lg` compaction for the PDP's reading blocks.
 *
 * On a phone the product information and the delivery/returns facts stack under the purchase panel,
 * all of it open, so a long description pushed the policies a shopper checks before buying many
 * screens down. Below `lg` the secondary blocks fold into one tappable row each and the description
 * shows its opening lines with "Xem thêm". From `lg` up nothing changes: the two columns already sit
 * side by side, so every block is drawn open and no toggle is rendered.
 *
 * Both are CSS-first (`hidden lg:block`) so the server-rendered page has no layout shift and the
 * desktop composition never waits on script. The content itself stays server-rendered children.
 */

const HEADING = "font-display text-xl font-normal tracking-[-0.02em]";

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
}: Readonly<{
  /** The desktop heading's id; the section is named by it on every viewport. */
  titleId: string;
  title: string;
  children: ReactNode;
}>) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <section className="border-b border-black/15 lg:py-6" aria-labelledby={titleId}>
      <h2 id={titleId} className={`hidden lg:block ${HEADING}`}>
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
 * Content shown by its opening lines below `lg`, with "Xem thêm" when there is more to read.
 *
 * The toggle appears only when the content actually overflows the clamp, measured after layout and
 * again on resize, so a two-line description never offers to expand into the same two lines.
 */
export function PdpClampedContent({ children }: Readonly<{ children: ReactNode }>) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const contentId = useId();

  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const measure = () => setOverflows(content.scrollHeight > content.clientHeight + 1);
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
      {overflows || expanded ? (
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
