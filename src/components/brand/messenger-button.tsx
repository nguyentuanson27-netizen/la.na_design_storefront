/**
 * The floating Messenger chat button, bottom right: the chat entry point wherever the Pancake chat
 * widget does not load (see `SiteChat`).
 *
 * A plain link to the fanpage's `m.me` chat rather than Meta's embedded chat widget: the Customer
 * Chat plugin was retired in 2024, and a link loads no third-party script. On a phone it opens the
 * Messenger app; on a desktop, messenger.com in a new tab. The link is derived from the approved
 * fanpage URL (`messengerUrlFromFanpage`). The stylesheet lifts it above the PDP's mobile purchase
 * bar.
 *
 * It sits outside the page's other landmarks, so it carries its own: a labelled `aside`, as the
 * masthead's promotion strip does, keeps every piece of page content inside a landmark.
 */
export function MessengerButton({ href, brandName }: Readonly<{ href: string; brandName: string }>) {
  return (
    <aside aria-label="Chat với shop">
      <a
        className="messenger-fab"
        href={href}
        rel="noreferrer"
        target="_blank"
        aria-label={`Nhắn tin với ${brandName} qua Messenger`}
      >
        <svg aria-hidden focusable={false} viewBox="0 0 24 24" width={30} height={30}>
          <defs>
            <linearGradient id="messenger-fab-gradient" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#0099ff" />
              <stop offset="0.6" stopColor="#a033ff" />
              <stop offset="0.9" stopColor="#ff5280" />
              <stop offset="1" stopColor="#ff7061" />
            </linearGradient>
          </defs>
          <path
            fill="url(#messenger-fab-gradient)"
            d="M.001 11.639C.001 4.949 5.241 0 12.001 0S24 4.95 24 11.639c0 6.689-5.24 11.638-12 11.638-1.21 0-2.38-.16-3.47-.46a.96.96 0 0 0-.64.05l-2.39 1.05a.96.96 0 0 1-1.35-.85l-.07-2.14a.97.97 0 0 0-.32-.68A11.39 11.39 0 0 1 .002 11.64zm8.32-2.19-3.52 5.6c-.35.53.32 1.14.82.75l3.79-2.87c.26-.2.6-.2.87 0l2.8 2.1c.84.63 2.04.4 2.6-.48l3.52-5.6c.35-.53-.32-1.13-.82-.75l-3.79 2.87c-.25.2-.6.2-.86 0l-2.8-2.1a1.8 1.8 0 0 0-2.61.48z"
          />
        </svg>
      </a>
    </aside>
  );
}
