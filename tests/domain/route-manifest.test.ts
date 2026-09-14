import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NAVIGATION } from "../../src/brand/index.ts";
import {
  STOREFRONT_ROUTES,
  matchesStorefrontRoute,
  routeUrlFromPath,
  storefrontRouteUrls,
} from "../../src/routes/manifest.ts";
import { checkMetadataContract, exportsAnyMetadata } from "../support/metadata-verifier.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every storefront `page.tsx` on disk. Admin is not a storefront route (spec 04 §8). */
function storefrontPagesOnDisk(): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(REPO_ROOT, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "admin") continue;
        walk(child);
      } else if (entry.name === "page.tsx") {
        found.push(child);
      }
    }
  };
  walk("src/app");
  return found.sort();
}

test("the manifest and the storefront pages on disk are the same set", () => {
  // Both directions on purpose. Deriving the manifest from disk would make it incapable of noticing
  // a page that disappeared, and checking only one direction lets the other drift silently.
  const declared = STOREFRONT_ROUTES.map((route) => route.path).sort();
  assert.deepEqual(declared, storefrontPagesOnDisk());
});

test("every manifest entry points at a file that exists", () => {
  for (const route of STOREFRONT_ROUTES) {
    assert.doesNotThrow(
      () => readFileSync(path.join(REPO_ROOT, route.path), "utf8"),
      `${route.path} exists`,
    );
    if (route.metadata === "layout") {
      assert.ok(route.metadataFile, `${route.path} declares layout mode so it must name a metadataFile`);
      assert.doesNotThrow(() => readFileSync(path.join(REPO_ROOT, route.metadataFile!), "utf8"));
    } else {
      assert.equal(
        route.metadataFile,
        undefined,
        `${route.path} only needs a metadataFile in layout mode`,
      );
    }
  }
});

/**
 * Whether a route has been migrated onto the route shell.
 *
 * Derived from the module rather than listed, so the split below cannot drift out of date as Phase E
 * lands one vertical slice at a time: importing `createStorefrontRoute` is exactly what makes the
 * full contract apply.
 */
function isMigrated(pagePath: string): boolean {
  return /from "@\/routes\/factory"/.test(readFileSync(path.join(REPO_ROOT, pagePath), "utf8"));
}

test("the declared metadata mode matches what each module actually exports today", () => {
  // A migrated route is held to the shipped verifier -- the thing the route contract is actually
  // defined by. It knows that such a page does not write `generateMetadata` itself but re-exports
  // the value `createStorefrontRoute` returned, which a regex reads as missing metadata.
  //
  // A route still waiting for its slice is held to the weaker shape it has today: metadata declared
  // where the manifest says, and only there. Each crosses to the verifier when its slice lands.
  for (const route of STOREFRONT_ROUTES) {
    const declaringFile = route.metadata === "layout" ? route.metadataFile! : route.path;
    const declaringSource = readFileSync(path.join(REPO_ROOT, declaringFile), "utf8");

    if (isMigrated(route.path)) {
      assert.deepEqual(
        checkMetadataContract({
          source: declaringSource,
          fileName: declaringFile,
          mode: route.metadata,
        }).map((violation) => violation.message),
        [],
        `${route.path} is migrated and declared ${route.metadata} mode`,
      );

      if (route.metadata === "layout") {
        assert.equal(
          exportsAnyMetadata(readFileSync(path.join(REPO_ROOT, route.path), "utf8"), route.path),
          false,
          `${route.path} is layout mode so its page must export no metadata`,
        );
      }
      continue;
    }

    const hasStatic = /export const metadata\b/.test(declaringSource);
    const hasGenerate = /export (async )?function generateMetadata\b/.test(declaringSource);

    if (route.metadata === "static") {
      assert.ok(hasStatic, `${route.path} is declared static so it must export a metadata const`);
      assert.equal(hasGenerate, false, `${route.path} must not also export generateMetadata`);
    } else if (route.metadata === "page") {
      assert.ok(hasGenerate, `${route.path} is declared page so it must export generateMetadata`);
      assert.equal(hasStatic, false, `${route.path} must not also export a metadata const`);
    } else {
      // PDP: the page must own no metadata at all, or Next would have two sources for one segment.
      assert.equal(
        exportsAnyMetadata(readFileSync(path.join(REPO_ROOT, route.path), "utf8"), route.path),
        false,
        `${route.path} is declared layout mode so its page must export no metadata`,
      );
      assert.match(declaringSource, /export (async )?function generateMetadata\b/);
    }
  }
});

test("exactly one route keeps its metadata in a layout, and it is the PDP", () => {
  const layoutRoutes = STOREFRONT_ROUTES.filter((route) => route.metadata === "layout");
  assert.deepEqual(
    layoutRoutes.map((route) => route.path),
    ["src/app/shop/[slug]/page.tsx"],
  );
});

/* ------------------------------------------------------- App Router URL mapping */

test("route URLs are derived by App Router convention", () => {
  assert.equal(routeUrlFromPath("src/app/page.tsx"), "/");
  assert.equal(routeUrlFromPath("src/app/shop/page.tsx"), "/shop");
  assert.equal(routeUrlFromPath("src/app/checkout/success/page.tsx"), "/checkout/success");
  assert.equal(routeUrlFromPath("src/app/shop/[slug]/page.tsx"), "/shop/[slug]");
  // Route groups contribute no URL segment.
  assert.equal(routeUrlFromPath("src/app/(marketing)/about/page.tsx"), "/about");
});

test("the manifest produces unique route URLs", () => {
  const urls = storefrontRouteUrls();
  assert.equal(new Set(urls).size, urls.length, `duplicate route URLs: ${urls.join(", ")}`);
});

/* ------------------------------------------------- NAVIGATION href ↔ route contract */

function navigationHrefs(): { label: string; href: string }[] {
  return [
    ...NAVIGATION.primary,
    ...NAVIGATION.mobileUtility,
    ...NAVIGATION.utility,
    ...NAVIGATION.footer,
  ].map((entry) => ({ label: entry.label, href: entry.href }));
}

test("every configured navigation href addresses a route the manifest declares", () => {
  // Before this, `loadBrandConfig` guaranteed only that an href was site-relative -- `/shops` was a
  // valid config and a 404 at runtime (spec 05 §5.2). This is the check that closes that gap, and it
  // lives here rather than in the brand-leak gate because a wrong href is a broken link, not a
  // brand leak.
  const broken = navigationHrefs().filter((entry) => !matchesStorefrontRoute(entry.href));

  assert.deepEqual(
    broken,
    [],
    `navigation entries point at no declared route:\n${broken
      .map((entry) => `  ${entry.href} (${entry.label})`)
      .join("\n")}`,
  );
});

test("the href check rejects a destination with no route, rather than passing everything", () => {
  assert.equal(matchesStorefrontRoute("/shop"), true);
  assert.equal(matchesStorefrontRoute("/shops"), false, "the typo that motivated this check");
  assert.equal(matchesStorefrontRoute("/shop/extra/depth"), false);
  assert.equal(matchesStorefrontRoute("/"), true);

  // A dynamic segment matches one non-empty segment.
  assert.equal(matchesStorefrontRoute("/shop/ao-thun-basic"), true);
  assert.equal(matchesStorefrontRoute("/collections/he-2026"), true);

  // Query and hash are not part of the path.
  assert.equal(matchesStorefrontRoute("/shop?sort=new"), true);
  assert.equal(matchesStorefrontRoute("/shop#top"), true);
});

test("the brand home label is navigation identity, and the wordmark still points at a real route", () => {
  assert.equal(matchesStorefrontRoute("/"), true);
  assert.ok(NAVIGATION.brandHomeLabel.trim().length > 0);
});
