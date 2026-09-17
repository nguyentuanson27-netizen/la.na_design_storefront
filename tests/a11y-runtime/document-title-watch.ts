import { expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * A settled-head guard for Axe scans that run after a Server Action revalidation.
 *
 * The root layout's `generateMetadata` awaits `connection()`, so the document head is dynamic and
 * gets re-streamed on every revalidation. React unmounts and remounts the hoisted `<title>` across
 * that swap, and `document.title` is empty in between. An Axe scan landing in that window reports
 * `document-title` — a WCAG 2.4.2 serious violation against a page whose title is fine.
 *
 * The guard this replaces was `await expect(page).toHaveTitle(/.+/)`. That is a **point-in-time**
 * observation, and the transient is not at a known point in time: the assertion passes against the
 * head that is still mounted, the swap happens next, and the scan reads the gap. It failed exactly
 * that way on `main` at af90e552 (admin-bulk-status.spec.ts, with the guard present) and on the I4
 * branch at e51d6cd (admin-bulk-operations.spec.ts, likewise guarded).
 *
 * So this waits for **continuity** instead: the title must have been non-empty for an uninterrupted
 * `quietMs`, measured inside the page, where an emptiness that lasts less than a poll interval is
 * still observable. Nothing here weakens the assertion — a title that never arrives, or one that
 * keeps flickering, times out and fails the test, which is the same verdict the old guard gave.
 *
 * The observation has to start before the transient, not when we want to read it, so the watch is
 * an init script and `expectSettledDocumentTitle` refuses to answer without one. A guard that
 * silently degraded to "true right now" when someone forgot to install it would be worse than no
 * guard at all: it would look like this fix while restoring the flake.
 */

const WATCH_KEY = "__laNaDocumentTitleWatch";

const DEFAULT_QUIET_MS = 1_000;

/**
 * Install the watch. Must run before the first navigation of the page under test.
 *
 * `addInitScript` runs in every document the target loads, so a client-side navigation or a full
 * reload mid-test is covered too, each with its own fresh record. Passing the context rather than
 * the page covers every page the test opens.
 */
export async function watchDocumentTitle(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript((key: string) => {
    const scope = window as unknown as Record<string, { lastEmptyAt: number } | undefined>;
    if (scope[key]) return;

    // At init time there is no head yet, so the title is legitimately empty: the clock starts now
    // rather than at zero, and the first settled window is the one after the head arrives.
    const record = { lastEmptyAt: Date.now() };
    scope[key] = record;

    const note = () => {
      if (!document.title) record.lastEmptyAt = Date.now();
    };

    // Two samplers, because either alone has a blind spot. The observer catches a removal whose
    // whole lifetime falls between two frames; the frame sampler catches a swap that the observer
    // batches into a single callback by which time the title is already back.
    new MutationObserver(note).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const sampleFrame = () => {
      note();
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
  }, WATCH_KEY);
}

/**
 * Wait until the document has carried a non-empty title continuously for `quietMs`.
 *
 * Call it immediately before an Axe scan that follows a Server Action, a revalidation or a
 * client-side navigation.
 */
export async function expectSettledDocumentTitle(
  page: Page,
  quietMs: number = DEFAULT_QUIET_MS,
): Promise<void> {
  // Keep the cheap assertion first: when a page genuinely renders no title, this is the failure a
  // reader can act on, rather than an opaque `waitForFunction` timeout.
  await expect(page).toHaveTitle(/.+/);

  await page.waitForFunction(
    ({ key, ms }: { key: string; ms: number }) => {
      const scope = window as unknown as Record<string, { lastEmptyAt: number } | undefined>;
      const record = scope[key];
      if (!record) {
        throw new Error(
          `${key} is missing: call watchDocumentTitle(page) before the first navigation`,
        );
      }
      if (!document.title) {
        record.lastEmptyAt = Date.now();
        return false;
      }
      return Date.now() - record.lastEmptyAt >= ms;
    },
    { key: WATCH_KEY, ms: quietMs },
    { timeout: 20_000 },
  );
}
