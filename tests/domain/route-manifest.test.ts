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

test("every route's metadata matches the mode the manifest declares", () => {
  // The live metadata gate (T32B). Every storefront route is migrated now, so every one is held to
  // the shipped verifier -- the thing the route contract is actually defined by -- rather than to
  // the weaker regex shape that stood in while the slices landed.
  for (const route of STOREFRONT_ROUTES) {
    const declaringFile = route.metadata === "layout" ? route.metadataFile! : route.path;
    const declaringSource = readFileSync(path.join(REPO_ROOT, declaringFile), "utf8");

    assert.deepEqual(
      checkMetadataContract({
        source: declaringSource,
        fileName: declaringFile,
        mode: route.metadata,
      }).map((violation) => violation.message),
      [],
      `${route.path} is declared ${route.metadata} mode`,
    );

    if (route.metadata === "layout") {
      // The page must own no metadata at all, or Next would have two sources for one segment.
      assert.equal(
        exportsAnyMetadata(readFileSync(path.join(REPO_ROOT, route.path), "utf8"), route.path),
        false,
        `${route.path} is layout mode so its page must export no metadata`,
      );
    }
  }
});

test("every storefront route renders through the shell", () => {
  // The other half of the live gate. A page can hold the boundary and still not be a route: a file
  // that imports only allowed modules and renders markup directly passes the boundary scan while
  // silently dropping the promotion refresh, the commerce event and the JSON-LD the shell mounts.
  for (const route of STOREFRONT_ROUTES.filter((entry) => entry.shell)) {
    const source = readFileSync(path.join(REPO_ROOT, route.path), "utf8");

    assert.match(
      source,
      /from "@\/routes\/factory"/,
      `${route.path} declares shell: true so it must be built by createStorefrontRoute`,
    );
    assert.match(
      source,
      /export default \w+\.Page/,
      `${route.path} must export the factory's Page, not its own component`,
    );
  }
});

test("the metadata gate is not vacuous: the same verifier rejects a contract breach", () => {
  // Guards the gate above. A verifier that returned no violations for anything would leave every
  // route green while checking nothing.
  assert.ok(
    checkMetadataContract({
      source: 'export const metadata = { title: "hand-written" };\n',
      fileName: "src/app/example/page.tsx",
      mode: "static",
    }).length > 0,
    "metadata not built by a canonical builder must fail",
  );
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
