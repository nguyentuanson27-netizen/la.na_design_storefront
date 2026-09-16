import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FULFILLMENT } from "../../src/brand/index.ts";
import {
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
} from "../../src/content/public-brand-facts.ts";
import { storefrontRouteUrls } from "../../src/routes/manifest.ts";
import {
  buildPolicyHubViewModel,
  POLICY_HUB_TOPICS,
  type PolicyTopicId,
} from "../../src/routes/evergreen-model.ts";
import { buildStaticPageMetadata } from "../../src/seo/static-page-metadata.ts";
import { STATIC_CANONICAL_PATHS } from "../../src/seo/search-sitemap-repository.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type TopicWithSections = ReturnType<typeof buildPolicyHubViewModel>["topics"][number] &
  Readonly<{
    sections?: readonly Readonly<{
      heading: string;
      paragraphs: readonly string[];
      items: readonly string[];
      closingParagraphs?: readonly string[];
    }>[];
  }>;

function topicText(topic: TopicWithSections): string {
  return [
    topic.title,
    topic.detail,
    topic.note ?? "",
    ...(topic.sections ?? []).flatMap((section) => [
      section.heading,
      ...section.paragraphs,
      ...section.items,
      ...(section.closingParagraphs ?? []),
    ]),
  ].join("\n");
}

/**
 * A7b — every policy topic the footer contract requires, reachable at a stable destination.
 *
 * Shipping, returns and contact keep their dedicated pages. The policy hub owns the remaining
 * approved legal/static content at stable anchors, and every sentence still comes from repository
 * policy authority rather than from JSX.
 */

/** Every topic the hub publishes must have a destination a visitor can actually reach. */
function resolvableDestinations(): readonly string[] {
  return [...storefrontRouteUrls()];
}

test("A7b the hub covers all eleven required policy topics", () => {
  assert.deepEqual(
    POLICY_HUB_TOPICS.map((topic) => topic.id),
    [
      "van-chuyen",
      "thanh-toan",
      "doi-tra-hoan-tien",
      "lien-he",
      "ho-tro-truc-tuyen",
      "khieu-nai",
      "dieu-khoan-chung",
      "chinh-sach-gia",
      "bao-mat",
      "dieu-kien-cung-cap",
      "quyen-nghia-vu",
    ],
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

test("A7b payment remains COD-only while refunds may keep their separate channel policy", () => {
  const byId = new Map(buildPolicyHubViewModel().topics.map((topic) => [topic.id, topic]));

  assert.equal(byId.get("thanh-toan")?.detail, FULFILLMENT.payment.codNote);
  assert.equal(
    byId.get("thanh-toan")?.note,
    FULFILLMENT.payment.bankTransferUnavailableNote,
  );

  const generalTerms = byId.get("dieu-khoan-chung" as PolicyTopicId) as
    | TopicWithSections
    | undefined;
  assert.ok(generalTerms);
  assert.doesNotMatch(topicText(generalTerms), /hỗ trợ.*chuyển khoản|chuyển khoản.*thanh toán/i);
  assert.match(topicText(generalTerms), /Thanh toán khi nhận hàng \(COD\)/);
});

test("A7b approved contact placeholders are resolved and no unsent contact form is advertised", () => {
  const model = buildPolicyHubViewModel();
  const published = JSON.stringify(model);
  assert.equal(published.includes("[Điền"), false);
  assert.equal(published.includes("Biểu mẫu liên hệ"), false);

  const onlineSupport = model.topics.find(
    (topic) => topic.id === ("ho-tro-truc-tuyen" as PolicyTopicId),
  ) as TopicWithSections | undefined;
  assert.ok(onlineSupport);
  const supportText = topicText(onlineSupport);
  for (const approved of [
    "www.lanadesign.vn",
    PUBLIC_CONTACT_FACTS.telephone,
    PUBLIC_CONTACT_FACTS.email,
    PUBLIC_CONTACT_FACTS.fanpageUrl,
    describePublicSupportHours(),
  ]) {
    assert.match(supportText, new RegExp(approved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("A7b all five formerly blocked legal topics now contain owner-approved sections", () => {
  const byId = new Map(buildPolicyHubViewModel().topics.map((topic) => [topic.id, topic]));
  for (const id of [
    "dieu-khoan-chung",
    "chinh-sach-gia",
    "bao-mat",
    "dieu-kien-cung-cap",
    "quyen-nghia-vu",
  ]) {
    const topic = byId.get(id as PolicyTopicId) as TopicWithSections | undefined;
    assert.ok(topic, id);
    assert.ok((topic.sections?.length ?? 0) > 0, `${id} has no approved sections`);
    assert.ok(topicText(topic).length > 200, `${id} is unexpectedly empty`);
  }
});

test("A7b order-confirmation copy preserves the approved source order around the steps", () => {
  const generalTerms = buildPolicyHubViewModel().topics.find(
    (topic) => topic.id === ("dieu-khoan-chung" as PolicyTopicId),
  ) as TopicWithSections | undefined;
  assert.ok(generalTerms);

  const ordering = generalTerms.sections?.find(
    (section) => section.heading === "Quy trình đặt hàng và xác nhận đơn hàng",
  );
  assert.ok(ordering);
  assert.deepEqual(ordering.paragraphs, [
    "Khách hàng có thể đặt hàng trên website theo các bước cơ bản sau:",
  ]);
  assert.equal(ordering.items.length, 6);
  assert.deepEqual(ordering.closingParagraphs, [
    "Đơn hàng chỉ được xem là hợp lệ sau khi La.na Design xác nhận thành công. Trong trường hợp thông tin đơn hàng chưa rõ ràng, La.na Design có thể liên hệ lại để xác minh trước khi xử lý.",
  ]);
});

test("A7b repository policy authority records the normalized owner decisions", () => {
  const authority = readFileSync(
    `${REPO_ROOT}docs/specs/la-na-design-policy-authority.md`,
    "utf8",
  );
  assert.match(authority, /Thanh toán khi nhận hàng \(COD\)\./);
  assert.match(authority, /www\.lanadesign\.vn/);
  assert.match(authority, /0923159666/);
  assert.match(authority, /la\.nadesignsince2022@gmail\.com/);
  assert.match(authority, /facebook\.com\/la\.nadesign\.vn/);
  assert.doesNotMatch(authority, /\[Điền/);
  assert.doesNotMatch(authority, /^\s*-\s*Chuyển khoản ngân hàng\.\s*$/m);
});

test("A7b the hub page is wired through the route factory like every other evergreen page", () => {
  const source = readFileSync(`${REPO_ROOT}src/app/policies/page.tsx`, "utf8");
  assert.match(source, /createStorefrontRoute/);
  assert.match(source, /buildPoliciesMetadata/);
  assert.match(source, /id=\{topic\.id\}/);
  assert.match(source, /topic\.sections/);
  assert.match(source, /section\.closingParagraphs/);
});
