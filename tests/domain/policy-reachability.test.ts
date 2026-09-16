import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FULFILLMENT } from "../../src/brand/index.ts";
import { PUBLIC_CONTACT_FACTS } from "../../src/content/public-brand-facts.ts";
import { storefrontRouteUrls } from "../../src/routes/manifest.ts";
import {
  buildPolicyHubViewModel,
  POLICY_HUB_TOPICS,
  type PolicyTopicId,
} from "../../src/routes/evergreen-model.ts";
import { buildStaticPageMetadata } from "../../src/seo/static-page-metadata.ts";
import { STATIC_CANONICAL_PATHS } from "../../src/seo/search-sitemap-repository.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A7b — every policy topic the footer contract requires, reachable at a stable destination.
 *
 * The hub is an index, not a second copy of the policy. Shipping, returns and contact keep their
 * own pages and the hub links to them; the topics with no page of their own -- payment, online
 * support, complaint handling -- are stated here from the same config constants those pages read.
 * What is asserted is that each destination resolves and that no clause is restated as page prose,
 * because a policy with two homes is a policy that disagrees with itself in one of them.
 */

/** Every topic the hub publishes must have a destination a visitor can actually reach. */
function resolvableDestinations(): readonly string[] {
  return [...storefrontRouteUrls()];
}

test("A7b the hub covers exactly the policy topics that have approved content", () => {
  assert.deepEqual(
    POLICY_HUB_TOPICS.map((topic) => topic.id),
    ["van-chuyen", "thanh-toan", "doi-tra-hoan-tien", "lien-he", "ho-tro-truc-tuyen", "khieu-nai"],
  );
});

test("A7b every topic anchor is stable, unique and URL-safe", () => {
  const seen = new Set<PolicyTopicId>();
  for (const topic of POLICY_HUB_TOPICS) {
    assert.match(topic.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, topic.id);
    assert.equal(seen.has(topic.id), false, `${topic.id} is duplicated`);
    seen.add(topic.id);
    assert.ok(topic.title.length > 0, topic.id);
  }
});

test("A7b every topic's destination resolves to a real route", () => {
  const routes = resolvableDestinations();

  for (const topic of buildPolicyHubViewModel().topics) {
    const [path, fragment] = topic.href.split("#");
    assert.ok(path, topic.id);
    assert.equal(
      routes.includes(path),
      true,
      `${topic.id} points at ${path}, which no route serves`,
    );
    if (fragment !== undefined) {
      assert.match(fragment, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${topic.id} fragment`);
    }
  }
});

test("A7b the hub itself is a declared, canonical, crawlable route", () => {
  assert.equal(storefrontRouteUrls().includes("/policies"), true);
  assert.equal(STATIC_CANONICAL_PATHS.includes("/policies"), true);

  // Self-canonical on the same terms as the other evergreen pages, and still withheld when the
  // exposure gate is closed -- a new policy page must not smuggle in an indexable signal.
  const origin = "https://shop.example.com";
  const indexed = buildStaticPageMetadata({
    origin,
    indexingEnabled: true,
    pathname: "/policies",
    searchParams: {},
  });
  assert.equal(indexed.alternates?.canonical, `${origin}/policies`);
  assert.equal(
    buildStaticPageMetadata({
      origin,
      indexingEnabled: false,
      pathname: "/policies",
      searchParams: {},
    }).alternates,
    undefined,
  );
});

test("A7b the hub restates no policy clause of its own", () => {
  const model = buildPolicyHubViewModel();
  const byId = new Map(model.topics.map((topic) => [topic.id, topic]));

  // Payment and complaints have no page of their own, so the hub states them -- from the config
  // constants, identically, rather than in words it chose.
  assert.equal(byId.get("thanh-toan")?.detail, FULFILLMENT.payment.codNote);
  assert.equal(
    byId.get("thanh-toan")?.note,
    FULFILLMENT.payment.bankTransferUnavailableNote,
  );
  assert.equal(byId.get("khieu-nai")?.detail, FULFILLMENT.support.complaintResponseNote);
  assert.equal(byId.get("ho-tro-truc-tuyen")?.detail, PUBLIC_CONTACT_FACTS.fanpageUrl);

  // Nothing on the hub is authored prose: every detail it shows is one of the approved constants.
  const approved = new Set<string>([
    FULFILLMENT.payment.codNote,
    FULFILLMENT.payment.bankTransferUnavailableNote,
    FULFILLMENT.support.complaintResponseNote,
    FULFILLMENT.delivery.coverage,
    FULFILLMENT.returns.refundChannelNote,
    PUBLIC_CONTACT_FACTS.fanpageUrl,
    PUBLIC_CONTACT_FACTS.email,
    PUBLIC_CONTACT_FACTS.telephone,
  ]);
  for (const topic of model.topics) {
    for (const value of [topic.detail, topic.note]) {
      if (value === null) continue;
      assert.equal(approved.has(value), true, `${topic.id} states copy no constant owns: ${value}`);
    }
  }
});

test("A7b the hub page is wired through the route factory like every other evergreen page", () => {
  const source = readFileSync(`${REPO_ROOT}src/app/policies/page.tsx`, "utf8");
  assert.match(source, /createStorefrontRoute/);
  assert.match(source, /buildPoliciesMetadata/);
  // Anchors are rendered as element ids, which is what makes a footer link to `#khieu-nai` land.
  assert.match(source, /id=\{topic\.id\}/);
});

test("A7b no policy topic is published without approved content behind it", () => {
  // The five §33 items with no approved source -- terms, pricing, privacy, supply conditions and
  // platform rights/obligations -- stay unbuilt rather than authored. A heading with nothing under
  // it is a placeholder, and a placeholder on a legal surface is worse than an absent page.
  const ids = POLICY_HUB_TOPICS.map((topic) => topic.id);
  for (const unapproved of ["dieu-khoan", "chinh-sach-gia", "bao-mat", "dieu-kien-cung-cap", "quyen-nghia-vu"]) {
    assert.equal(ids.includes(unapproved as PolicyTopicId), false, unapproved);
  }
});
