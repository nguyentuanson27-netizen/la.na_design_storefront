"use client";

import { useT } from "@/i18n/client";

/**
 * The floating Zalo chat button, bottom right: the storefront's one chat entry point (see `SiteChat`).
 *
 * A plain link to the shop's Zalo (`zalo.me/<number>`, derived from the approved support number by
 * `zaloUrlFromTelephone`): it loads no third-party script, and on a phone it opens the Zalo app. The
 * stylesheet lifts it above the PDP's mobile purchase bar and clear of the photograph's counter.
 *
 * It sits outside the page's other landmarks, so it carries its own: a labelled `aside`, as the
 * masthead's promotion strip does, keeps every piece of page content inside a landmark.
 */
export function ZaloButton({ href, brandName }: Readonly<{ href: string; brandName: string }>) {
  const t = useT();
  return (
    <aside aria-label={t("Chat với shop")}>
      <a
        className="zalo-fab"
        href={href}
        rel="noreferrer"
        target="_blank"
        aria-label={t("Nhắn tin với {brandName} qua Zalo", { brandName })}
      >
        <span aria-hidden="true">Zalo</span>
      </a>
    </aside>
  );
}
