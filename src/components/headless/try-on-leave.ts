/**
 * When a shopper is about to lose a try-on that is still being made.
 *
 * A generation lives in this tab's memory (`try-on-session.tsx`). It survives closing the dialog and
 * moving between pages of the app, but not the page being unloaded: closing the tab, reloading, or
 * following a link that loads a whole new document. The attempt is already spent by then (the server
 * counts it on arrival), so the picture is simply lost.
 *
 * The browser gives a site two ways to react, and they are different in kind:
 *
 *   - `beforeunload` can only raise the browser's own confirmation, with wording the site cannot
 *     set. It is the safety net for everything below and for what cannot be seen coming (the close
 *     button, reload, the address bar).
 *   - A click on a link that would unload the document, and a pointer leaving through the top edge
 *     of the window, can be seen *before* it happens. Those are the two places the site can show its
 *     own message, with something better to offer than "are you sure".
 *
 * This holds the decisions only, with no DOM, so they can be tested without a browser.
 */

export type LeaveClick = Readonly<{
  /** The anchor's resolved absolute URL (`HTMLAnchorElement.href`). */
  href: string;
  /** The page's own origin (`location.origin`). */
  origin: string;
  /** The anchor's `target`, as written ("" when absent). */
  target: string;
  /** The anchor has a `download` attribute. */
  download: boolean;
  /** The anchor is a plain `<a>` the app uses for a full page load (the language switcher). */
  reloads: boolean;
  /** `MouseEvent.button`. */
  button: number;
  /** Any of ctrl, meta, shift or alt was held: the browser opens a tab or window, this one stays. */
  modified: boolean;
  /** Something already handled the click (`event.defaultPrevented`). */
  defaultPrevented: boolean;
}>;

/**
 * Whether following this click would unload the current page, and so lose the picture in progress.
 *
 * Links inside the app are not asked about: Next swaps the page without unloading the document and
 * the dock carries the job along, so stopping the shopper there would only be an obstacle. What does
 * unload is a link to another site, and the few plain anchors that reload (`reloads`).
 */
export function isUnloadingClick(click: LeaveClick): boolean {
  if (click.defaultPrevented || click.button !== 0 || click.modified || click.download) return false;
  if (click.target !== "" && click.target.toLowerCase() !== "_self") return false;

  let url: URL;
  try {
    url = new URL(click.href);
  } catch {
    return false;
  }
  // `mailto:`, `tel:` and the like hand over to another app; the page stays.
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // A jump within this page (`#size-guide`) is not a navigation at all.
  const here = new URL(click.origin);
  if (url.origin === here.origin) {
    return click.reloads;
  }
  return true;
}

export type ExitSignal = Readonly<{
  /** `MouseEvent.clientY` of a `mouseout` on the document. */
  clientY: number;
  /** `MouseEvent.relatedTarget`: null when the pointer left the document altogether. */
  relatedTarget: EventTarget | null;
  /** The device has a mouse that hovers (`(hover: hover) and (pointer: fine)`). */
  finePointer: boolean;
}>;

/**
 * A pointer leaving through the top edge of the window: the movement towards the tab bar, the close
 * button or the address bar. It is a hint, not a promise (a shopper reaching for the bookmarks bar
 * does it too), which is why the response to it is a polite offer shown once per job and never a
 * blocking prompt. Touch screens have no such movement, so they never produce one.
 */
export function isExitIntent(signal: ExitSignal): boolean {
  return signal.finePointer && signal.relatedTarget === null && signal.clientY <= 0;
}

/**
 * The ways out the leave prompt offers, besides staying. Which of them applies depends on how the
 * prompt was raised: a link click has somewhere it was going; a pointer leaving the window does not.
 */
export type LeaveOffer = Readonly<{
  /** Open the link the shopper was going to in a new tab and keep this one (needs a `href`). */
  newTab: boolean;
  /** Go on to the link anyway, losing the picture (needs a `href`). */
  leave: boolean;
}>;

export function leaveOffer(href: string | null): LeaveOffer {
  return { newTab: href !== null, leave: href !== null };
}
