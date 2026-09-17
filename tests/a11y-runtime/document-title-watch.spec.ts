/**
 * The guard in `document-title-watch.ts` is subtle enough to regress silently — a watch that is
 * never installed, or a quiet window measured from the wrong instant, both look like a working
 * guard while letting the transient straight through. These pin its behaviour with no server and no
 * app: a document whose title is removed and restored on a timer reproduces the head swap exactly.
 *
 * Every assertion here is two-directional on purpose. The middle test asserts both that the old
 * one-shot check returns immediately (so the scan would have run into the gap) and that the new one
 * does not return until the quiet window has run from the restore. A test that only asserted the
 * second would still pass if the guard degraded back to the first.
 */

import { expect, test } from "@playwright/test";

import { expectSettledDocumentTitle, watchDocumentTitle } from "./document-title-watch.ts";

const PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<!doctype html><html lang="vi"><head><title>Settled</title></head><body><main>x</main></body></html>`,
  );

test("the guard returns promptly when the head never swaps", async ({ page }) => {
  await watchDocumentTitle(page);
  await page.goto(PAGE);

  const started = Date.now();
  await expectSettledDocumentTitle(page, 1_000);
  const elapsed = Date.now() - started;

  expect(elapsed).toBeGreaterThanOrEqual(900);
  expect(elapsed).toBeLessThan(3_000);
});

test("the guard waits out a title that disappears after the old one-shot check would have passed", async ({
  page,
}) => {
  await watchDocumentTitle(page);
  await page.goto(PAGE);

  // The exact failure shape: the title is present now, so `toHaveTitle(/.+/)` passes immediately,
  // and only then does the head swap.
  const oneShotStarted = Date.now();
  await expect(page).toHaveTitle(/.+/);
  expect(Date.now() - oneShotStarted).toBeLessThan(500);

  await page.evaluate(() => {
    const title = document.querySelector("title")!;
    setTimeout(() => title.remove(), 200);
    setTimeout(() => document.head.append(title), 1_200);
  });

  const started = Date.now();
  await expectSettledDocumentTitle(page, 1_000);
  const elapsed = Date.now() - started;

  // It must not return during the gap, and not immediately when the title comes back either: the
  // quiet window has to run from the restore at ~1200ms.
  expect(elapsed).toBeGreaterThanOrEqual(2_100);
  expect(await page.title()).toBe("Settled");
});

test("the guard fails rather than silently passing when the watch was never installed", async ({
  page,
}) => {
  await page.goto(PAGE);
  await expect(expectSettledDocumentTitle(page, 200)).rejects.toThrow(
    /call watchDocumentTitle\(page\) before the first navigation/,
  );
});
