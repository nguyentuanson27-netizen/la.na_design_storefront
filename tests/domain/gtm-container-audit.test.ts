/**
 * U28 / T8 — the static gate that must be green before any GTM loader or CSP origin may land.
 *
 * This audit reads a checked-in container export and answers one question: may this exact artifact
 * be loaded by the storefront? It is a security control, not a linter, so every rule below is
 * fail-closed — an export it cannot fully understand is refused rather than waved through. That
 * matters more than usual here, because the published GTM export schema could not be fetched from
 * Google's own documentation in this environment (both `developers.google.com` and
 * `support.google.com` are egress-blocked), so the parser treats anything unrecognised as a
 * violation instead of assuming it is benign.
 *
 * Tag Assistant is explicitly not a substitute for any of this: it observes one preview session,
 * while these assertions bind the artifact itself.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditGtmContainerExport,
  GTM_AUDIT_CODES,
  type GtmApprovedDestinations,
} from "../../src/tracking/gtm-container-audit.ts";

/** Stand-in vendor ids. Real values are owner gate O4 and are not invented here. */
const APPROVED: GtmApprovedDestinations = {
  gtmContainerId: "GTM-FIXTURE",
  ga4MeasurementIds: ["G-FIXTURE001"],
  googleAdsConversions: [{ conversionId: "AW-FIXTURE001", conversionLabel: "FixtureLabel01" }],
  tiktokPixelIds: ["FIXTUREPIXEL01"],
};

const LIVE_TRIGGER_ID = "10";
const ALWAYS_TRIGGER_ID = "11";

function liveGuardTrigger() {
  return {
    triggerId: LIVE_TRIGGER_ID,
    name: "Tracking mode is live",
    type: "pageview",
    filter: [
      {
        type: "equals",
        parameter: [
          { type: "TEMPLATE", key: "arg0", value: "{{la_tracking_mode}}" },
          { type: "TEMPLATE", key: "arg1", value: "live" },
        ],
      },
    ],
  };
}

function unguardedTrigger() {
  return { triggerId: ALWAYS_TRIGGER_ID, name: "All pages", type: "pageview" };
}

function ga4ConfigTag(overrides: Record<string, unknown> = {}) {
  return {
    tagId: "1",
    name: "GA4 configuration",
    type: "gaawc",
    firingTriggerId: [LIVE_TRIGGER_ID],
    parameter: [
      { type: "TEMPLATE", key: "measurementId", value: "G-FIXTURE001" },
      { type: "BOOLEAN", key: "sendPageView", value: "false" },
    ],
    ...overrides,
  };
}

function adsConversionTag(overrides: Record<string, unknown> = {}) {
  return {
    tagId: "2",
    name: "Google Ads Purchase",
    type: "awct",
    firingTriggerId: [LIVE_TRIGGER_ID],
    parameter: [
      { type: "TEMPLATE", key: "conversionId", value: "AW-FIXTURE001" },
      { type: "TEMPLATE", key: "conversionLabel", value: "FixtureLabel01" },
      { type: "TEMPLATE", key: "orderId", value: "{{publicCode}}" },
    ],
    ...overrides,
  };
}

function ga4EventTag(overrides: Record<string, unknown> = {}) {
  return {
    tagId: "3",
    name: "GA4 purchase",
    type: "gaawe",
    firingTriggerId: [LIVE_TRIGGER_ID],
    parameter: [
      { type: "TEMPLATE", key: "eventName", value: "purchase" },
      { type: "TEMPLATE", key: "transactionId", value: "{{publicCode}}" },
    ],
    ...overrides,
  };
}

/**
 * TikTok delivered through its gallery template.
 *
 * Kept as a fixture precisely because the audit refuses it. The saved export *does* carry the
 * template — `customTemplate[].templateData`, plus a `galleryReference` for a gallery one — so what
 * is missing is not the code but a reviewed parser bound to that exact template, without which no
 * parameter allowlist can say where the tag sends. It is a refusal case here, not a happy path.
 */
function tiktokTemplateTag(overrides: Record<string, unknown> = {}) {
  return {
    tagId: "4",
    name: "TikTok CompletePayment",
    type: "cvt_tiktok_pixel",
    firingTriggerId: [LIVE_TRIGGER_ID],
    parameter: [
      { type: "TEMPLATE", key: "pixelId", value: "FIXTUREPIXEL01" },
      { type: "TEMPLATE", key: "eventId", value: "{{publicCode}}" },
    ],
    ...overrides,
  };
}

/**
 * The application-owned mode fact, as a Data Layer Variable.
 *
 * Every firing guard names this variable, so the container has to define it as a read of the
 * dataLayer key the application pushes. A container without it — or with a Constant of the same
 * name — has guards that prove nothing, which is its own regression below.
 */
function trackingModeVariable(overrides: Record<string, unknown> = {}) {
  return {
    variableId: "1",
    name: "la_tracking_mode",
    type: "v",
    parameter: [
      { type: "INTEGER", key: "dataLayerVersion", value: "2" },
      { type: "TEMPLATE", key: "name", value: "la_tracking_mode" },
    ],
    ...overrides,
  };
}

function containerExport(overrides: Record<string, unknown> = {}) {
  const { variable, ...rest } = overrides;

  // A container with no `variable` override gets the correct mode variable, so an unrelated fixture
  // is not accidentally testing a missing guard source. A test that passes its own list owns the
  // whole list, mode variable included — that is how the missing and malformed cases are written.
  const variables = variable === undefined ? [trackingModeVariable()] : variable;

  return {
    exportFormatVersion: 2,
    containerVersion: {
      accountId: "0",
      containerId: "0",
      containerVersionId: "7",
      container: { publicId: "GTM-FIXTURE", usageContext: ["web"] },
      tag: [ga4ConfigTag(), adsConversionTag(), ga4EventTag()],
      trigger: [liveGuardTrigger(), unguardedTrigger()],
      variable: variables,
      ...rest,
    },
  };
}

function codes(result: ReturnType<typeof auditGtmContainerExport>): string[] {
  return [...new Set(result.findings.map((finding) => finding.code))].sort();
}

describe("GTM container export static audit", () => {
  it("passes a reviewed saved version whose production tags are all live-guarded", () => {
    const result = auditGtmContainerExport({
      source: containerExport(),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    assert.equal(result.containerVersionId, "7");
    assert.equal(result.containerPublicId, "GTM-FIXTURE");
  });

  for (const [label, source] of [
    ["a non-object", 42],
    ["null", null],
    ["an empty object", {}],
    ["a container version that is not an object", { containerVersion: "nope" }],
    ["a tag list that is not an array", containerExport({ tag: "nope" })],
  ] as const) {
    it(`refuses ${label} instead of assuming it is benign`, () => {
      const result = auditGtmContainerExport({ source, approved: APPROVED });

      assert.equal(result.ok, false);
      assert.ok(
        codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT),
        "an export this audit cannot parse must be refused, never skipped",
      );
    });
  }

  it("refuses a mutable workspace export that names no saved version", () => {
    for (const containerVersionId of [undefined, "", "0"]) {
      const result = auditGtmContainerExport({
        source: containerExport({ containerVersionId }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.NOT_A_SAVED_VERSION));
    }
  });

  for (const [label, tag] of [
    ["GA4", ga4ConfigTag({ firingTriggerId: [ALWAYS_TRIGGER_ID] })],
    ["Google Ads", adsConversionTag({ firingTriggerId: [ALWAYS_TRIGGER_ID] })],
    ["GA4 event", ga4EventTag({ firingTriggerId: [ALWAYS_TRIGGER_ID] })],
  ] as const) {
    it(`fails a production ${label} tag whose firing trigger has no live guard`, () => {
      const result = auditGtmContainerExport({
        source: containerExport({ tag: [tag], trigger: [liveGuardTrigger(), unguardedTrigger()] }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD));
    });
  }

  it("fails a tag with no firing trigger at all", () => {
    const result = auditGtmContainerExport({
      source: containerExport({ tag: [ga4ConfigTag({ firingTriggerId: [] })] }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD));
  });

  it("fails a tag guarded on a mode other than live", () => {
    const previewGuard = {
      triggerId: "12",
      name: "Tracking mode is preview",
      type: "pageview",
      filter: [
        {
          type: "equals",
          parameter: [
            { type: "TEMPLATE", key: "arg0", value: "{{la_tracking_mode}}" },
            { type: "TEMPLATE", key: "arg1", value: "preview" },
          ],
        },
      ],
    };
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ firingTriggerId: ["12"] })],
        trigger: [previewGuard],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD));
  });

  it("fails a tag whose firing trigger id resolves to no trigger", () => {
    // A dangling reference cannot be shown to carry a guard, so it is refused rather than trusted.
    const result = auditGtmContainerExport({
      source: containerExport({ tag: [ga4ConfigTag({ firingTriggerId: ["999"] })] }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD));
  });

  it("requires every firing trigger of a tag to carry the guard, not merely one of them", () => {
    // One unguarded path is enough to fire the tag, so any unguarded trigger fails the tag.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ firingTriggerId: [LIVE_TRIGGER_ID, ALWAYS_TRIGGER_ID] })],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD));
  });

  for (const [label, type] of [
    ["a gallery template", "cvt_unknown_vendor"],
    ["a Custom HTML tag", "html"],
    ["a tag carrying no type at all", ""],
  ] as const) {
    it(`refuses ${label} even when every firing path is live-guarded`, () => {
      // The live guard says *when* the tag fires, never *where* it delivers. For these types the
      // delivery lives in code the export does not contain, so nothing here bounds the destination
      // and the guard cannot stand in for one.
      const result = auditGtmContainerExport({
        source: containerExport({
          tag: [{ tagId: "9", name: "Mystery", type, firingTriggerId: [LIVE_TRIGGER_ID], parameter: [] }],
        }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAUDITABLE_TAG_TYPE));
    });
  }

  it("refuses a live-guarded custom tag whose delivery hides under an unrecognised key", () => {
    // This is the shape a parameter allowlist cannot catch: production delivery under `html`, with
    // no recognised destination key anywhere on the tag, so the destination scan finds nothing.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "9",
          name: "Vendor snippet",
          type: "html",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [{
            type: "TEMPLATE",
            key: "html",
            value: "<script>ttq.load('SOMEONEELSESPIXEL')</script>",
          }],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(
      codes(result).includes(GTM_AUDIT_CODES.UNAUDITABLE_TAG_TYPE),
      "a live guard must not certify a tag whose destination the export does not bound",
    );
  });

  it("refuses TikTok delivered through its gallery template, and says why", () => {
    // Recorded deliberately: T8 wants TikTok, and this audit as written cannot certify it through
    // GTM. Admitting it takes a reviewed parser for that exact template, not a passing default.
    const result = auditGtmContainerExport({
      source: containerExport({ tag: [tiktokTemplateTag()] }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAUDITABLE_TAG_TYPE));
  });

  it("rejects any Meta tag in the container, guarded or not", () => {
    // Meta stays a direct first-party integration. A Meta tag here would duplicate the browser
    // pixel and break the CAPI deduplication that pairs on order code.
    for (const metaTag of [
      { tagId: "8", name: "Facebook Pixel", type: "html", firingTriggerId: [LIVE_TRIGGER_ID], parameter: [{ type: "TEMPLATE", key: "html", value: "<script>fbq('init','1')</script>" }] },
      { tagId: "8", name: "Meta CompletePayment", type: "cvt_meta_pixel", firingTriggerId: [LIVE_TRIGGER_ID], parameter: [] },
    ]) {
      const result = auditGtmContainerExport({
        source: containerExport({ tag: [metaTag] }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.META_TAG_PRESENT));
    }
  });

  it("finds a Meta integration nested inside list or map parameters", () => {
    // Custom templates and some built-in types nest their real payload one or more levels down. A
    // scan that only reads top-level strings would wave this through, which is the fail-open this
    // audit exists to prevent.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [
          {
            tagId: "8",
            name: "Third party bundle",
            type: "cvt_generic_template",
            firingTriggerId: [LIVE_TRIGGER_ID],
            parameter: [
              {
                type: "LIST",
                key: "settings",
                list: [
                  {
                    type: "MAP",
                    map: [
                      { type: "TEMPLATE", key: "snippet", value: "fbq('track','Purchase')" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.META_TAG_PRESENT));
  });

  it("finds an unapproved destination id nested inside list or map parameters", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [
          {
            tagId: "9",
            name: "Nested destination",
            type: "cvt_generic_template",
            firingTriggerId: [LIVE_TRIGGER_ID],
            parameter: [
              {
                type: "MAP",
                key: "config",
                map: [{ type: "TEMPLATE", key: "measurementId", value: "G-NOTAPPROVED" }],
              },
            ],
          },
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  it("refuses a tag nested deeper than the audit will walk", () => {
    // The export is untrusted JSON. A pathological structure must make the audit fail loudly rather
    // than hang or silently stop scanning half of a tag.
    let nested: unknown = { type: "TEMPLATE", key: "snippet", value: "fbq('track')" };
    for (let depth = 0; depth < 60; depth += 1) nested = { type: "LIST", list: [nested] };

    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{ tagId: "9", name: "Deep", type: "cvt_x", firingTriggerId: [LIVE_TRIGGER_ID], parameter: [nested] }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("fails a GA4 configuration that leaves automatic page views on", () => {
    // The application owns the canonical page view. A GA4 config that also sends one produces two
    // page views per navigation.
    for (const parameter of [
      [{ type: "TEMPLATE", key: "measurementId", value: "G-FIXTURE001" }],
      [
        { type: "TEMPLATE", key: "measurementId", value: "G-FIXTURE001" },
        { type: "BOOLEAN", key: "sendPageView", value: "true" },
      ],
    ]) {
      const result = auditGtmContainerExport({
        source: containerExport({ tag: [ga4ConfigTag({ parameter })] }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW));
    }
  });

  function constantVariable(name: string, value: string) {
    return {
      variableId: "100",
      name,
      type: "c",
      parameter: [{ type: "TEMPLATE", key: "value", value }],
    };
  }

  it("resolves a variable reference and accepts it when it names an approved destination", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ parameter: [
          { type: "TEMPLATE", key: "measurementId", value: "{{Prod GA4}}" },
          { type: "BOOLEAN", key: "sendPageView", value: "false" },
        ] })],
        variable: [trackingModeVariable(), constantVariable("Prod GA4", "G-FIXTURE001")],
      }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it("fails a variable reference that resolves to an unapproved destination", () => {
    // The indirection is the whole point of the finding: the literal never appears on the tag.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ parameter: [
          { type: "TEMPLATE", key: "measurementId", value: "{{Prod GA4}}" },
          { type: "BOOLEAN", key: "sendPageView", value: "false" },
        ] })],
        variable: [trackingModeVariable(), constantVariable("Prod GA4", "G-NOTAPPROVED")],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  for (const [label, variables] of [
    ["names no variable in the container", []],
    ["names a variable this audit cannot resolve to a literal", [
      { variableId: "100", name: "Prod GA4", type: "jsm", parameter: [] },
    ]],
    ["names a variable that itself defers to another reference", [
      { variableId: "100", name: "Prod GA4", type: "c", parameter: [{ type: "TEMPLATE", key: "value", value: "{{Deeper}}" }] },
    ]],
  ] as const) {
    it(`refuses a destination reference that ${label}`, () => {
      const result = auditGtmContainerExport({
        source: containerExport({
          tag: [ga4ConfigTag({ parameter: [
            { type: "TEMPLATE", key: "measurementId", value: "{{Prod GA4}}" },
            { type: "BOOLEAN", key: "sendPageView", value: "false" },
          ] })],
          variable: [trackingModeVariable(), ...variables],
        }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNRESOLVED_DESTINATION_REFERENCE));
    });
  }

  it("resolves a variable reference nested inside list or map parameters", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "5",
          name: "Nested indirect destination",
          type: "cvt_generic_template",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [{
            type: "MAP",
            key: "config",
            map: [{ type: "TEMPLATE", key: "pixelId", value: "{{Prod TikTok}}" }],
          }],
        }],
        variable: [trackingModeVariable(), constantVariable("Prod TikTok", "NOTAPPROVEDPIXEL")],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  it("fails a current Google tag that never proves page views are off", () => {
    // The GA4 Configuration tag became the Google tag, and the page-view toggle moved into
    // configuration settings or a referenced settings variable. A live guard alone is not proof.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [{ type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" }],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW));
  });

  it("accepts a Google tag that disables page views inside nested configuration settings", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            {
              type: "LIST",
              key: "configSettingsTable",
              list: [{
                type: "MAP",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                  { type: "TEMPLATE", key: "parameterValue", value: "false" },
                ],
              }],
            },
          ],
        }],
      }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it("accepts a Google tag whose referenced settings variable disables page views", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            { type: "TEMPLATE", key: "configSettingsVariable", value: "{{Config settings}}" },
          ],
        }],
        variable: [trackingModeVariable(), {
          variableId: "101",
          name: "Config settings",
          type: "gtcs",
          parameter: [{
            type: "LIST",
            key: "configSettingsTable",
            list: [{
              type: "MAP",
              map: [
                { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                { type: "TEMPLATE", key: "parameterValue", value: "false" },
              ],
            }],
          }],
        }],
      }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it("fails a Google tag whose settings variable cannot be found", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            { type: "TEMPLATE", key: "configSettingsVariable", value: "{{Missing settings}}" },
          ],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW));
  });

  it("fails a Google tag that explicitly sends page views", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            {
              type: "LIST",
              key: "configSettingsTable",
              list: [{
                type: "MAP",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                  { type: "TEMPLATE", key: "parameterValue", value: "true" },
                ],
              }],
            },
          ],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW));
  });

  it("does not let one settings row prove a claim another row makes", () => {
    // The fail-open this replaces: flattening the settings table into loose pairs let the `false`
    // of an unrelated row satisfy the `send_page_view` of a row that actually said `true`.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            {
              type: "LIST",
              key: "configSettingsTable",
              list: [
                {
                  type: "MAP",
                  map: [
                    { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                    { type: "TEMPLATE", key: "parameterValue", value: "true" },
                  ],
                },
                {
                  type: "MAP",
                  map: [
                    { type: "TEMPLATE", key: "parameter", value: "some_other_setting" },
                    { type: "TEMPLATE", key: "parameterValue", value: "false" },
                  ],
                },
              ],
            },
          ],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(
      codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW),
      "a false from an unrelated setting must not prove page views are off",
    );
  });

  it("refuses a settings row that names the page-view toggle but carries no value", () => {
    // The tag elsewhere says false, so skipping the incomplete row would read as proof. A row that
    // names the toggle and then says nothing about it is an open question, not a `false`.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            { type: "BOOLEAN", key: "sendPageView", value: "false" },
            {
              type: "LIST",
              key: "configSettingsTable",
              list: [{
                type: "MAP",
                map: [{ type: "TEMPLATE", key: "parameter", value: "send_page_view" }],
              }],
            },
          ],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW));
  });

  it("refuses a Google tag that claims the toggle both ways", () => {
    // Contradictory claims are not proof. Reading either one alone would pick the answer by scan
    // order rather than by evidence.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            { type: "BOOLEAN", key: "sendPageView", value: "false" },
            {
              type: "LIST",
              key: "configSettingsTable",
              list: [{
                type: "MAP",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                  { type: "TEMPLATE", key: "parameterValue", value: "true" },
                ],
              }],
            },
          ],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW));
  });

  it("finds a Meta payload that only a referenced variable carries", () => {
    // The tag itself holds no Meta marker at all; the snippet lives in the variable it embeds. A
    // scan of the tag object alone would read the reference and never the payload.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "9",
          name: "Vendor snippet",
          type: "html",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [{ type: "TEMPLATE", key: "html", value: "<script>{{Vendor snippet body}}</script>" }],
        }],
        variable: [trackingModeVariable(), constantVariable("Vendor snippet body", "fbq('track','Purchase')")],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.META_TAG_PRESENT));
  });

  it("finds a Meta payload two variable hops away", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "9",
          name: "Vendor snippet",
          type: "html",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [{ type: "TEMPLATE", key: "html", value: "<script>{{Outer}}</script>" }],
        }],
        variable: [
          trackingModeVariable(),
          constantVariable("Outer", "wrap({{Inner}})"),
          constantVariable("Inner", "fbevents.js"),
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.META_TAG_PRESENT));
  });

  it("terminates on variables that reference each other in a cycle", () => {
    // The export is untrusted JSON, so a cycle must end the walk rather than hang the audit.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ parameter: [
          { type: "TEMPLATE", key: "measurementId", value: "G-FIXTURE001" },
          { type: "BOOLEAN", key: "sendPageView", value: "false" },
          { type: "TEMPLATE", key: "note", value: "{{A}}" },
        ] })],
        variable: [trackingModeVariable(), constantVariable("A", "sees {{B}}"), constantVariable("B", "sees {{A}}")],
      }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it("does not let an unrelated variable answer for configuration settings the tag never wired", () => {
    // The tag names no settings table and no settings variable, so nothing about it says page views
    // are off. Following every reference on the tag let a variable it merely mentions supply the
    // proof — a `false` about a configuration this tag does not use.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            { type: "TEMPLATE", key: "note", value: "{{Unrelated settings}}" },
          ],
        }],
        variable: [trackingModeVariable(), {
          variableId: "101",
          name: "Unrelated settings",
          type: "gtcs",
          parameter: [{
            type: "LIST",
            key: "configSettingsTable",
            list: [{
              type: "MAP",
              map: [
                { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                { type: "TEMPLATE", key: "parameterValue", value: "false" },
              ],
            }],
          }],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(
      codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW),
      "only a settings carrier the tag actually names may prove the toggle",
    );
  });

  it("fails a Google Ads conversion that pairs a reviewed id with an unreviewed label", () => {
    // The id names the account; the label names the conversion action. Approving them separately
    // would let a reviewed account report a conversion nobody looked at.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [adsConversionTag({ parameter: [
          { type: "TEMPLATE", key: "conversionId", value: "AW-FIXTURE001" },
          { type: "TEMPLATE", key: "conversionLabel", value: "SomeOtherLabel" },
        ] })],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  it("fails a Google Ads conversion that names no label at all", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [adsConversionTag({ parameter: [
          { type: "TEMPLATE", key: "conversionId", value: "AW-FIXTURE001" },
        ] })],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  it("fails a Google Ads conversion whose label is reviewed under a different id", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [adsConversionTag({ parameter: [
          { type: "TEMPLATE", key: "conversionId", value: "AW-FIXTURE002" },
          { type: "TEMPLATE", key: "conversionLabel", value: "FixtureLabel01" },
        ] })],
      }),
      approved: {
        ...APPROVED,
        googleAdsConversions: [
          { conversionId: "AW-FIXTURE001", conversionLabel: "FixtureLabel01" },
          { conversionId: "AW-FIXTURE002", conversionLabel: "FixtureLabel02" },
        ],
      },
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  it("does not let one vendor's approved id satisfy another vendor's field", () => {
    // A flat union of approved ids proves only that a literal appears somewhere in the approved set.
    // Here the pixel id is genuinely approved — for TikTok, not for a Google tag.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            { type: "TEMPLATE", key: "pixelId", value: "FIXTUREPIXEL01" },
            { type: "BOOLEAN", key: "sendPageView", value: "false" },
          ],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  it("does not let a GA4 measurement id satisfy a Google Ads conversion", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [adsConversionTag({ parameter: [
          { type: "TEMPLATE", key: "conversionId", value: "G-FIXTURE001" },
          { type: "TEMPLATE", key: "conversionLabel", value: "FixtureLabel01" },
        ] })],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  for (const [label, exportFormatVersion] of [
    ["declares no export format", undefined],
    ["declares a format this parser was not written against", 999],
    ["declares its format as a string", "2"],
  ] as const) {
    it(`refuses an export that ${label}`, () => {
      const source = { ...containerExport(), exportFormatVersion };
      const result = auditGtmContainerExport({ source, approved: APPROVED });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNSUPPORTED_EXPORT_FORMAT));
    });
  }

  it("refuses a variable list that is not an array rather than reading it as empty", () => {
    // Every reference would resolve to nothing and the container would look cleaner than it is.
    // An unreadable variable list is not an empty one: every reference would resolve to nothing and
    // the container would look cleaner than it is.
    const result = auditGtmContainerExport({
      source: containerExport({ variable: { "Prod GA4": "G-FIXTURE001" } }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("accepts guards built on a Data Layer Variable that reads the application's mode key", () => {
    const result = auditGtmContainerExport({
      source: containerExport({ variable: [trackingModeVariable()] }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  for (const [label, definition] of [
    ["a Constant that simply returns live", {
      variableId: "1",
      name: "la_tracking_mode",
      type: "c",
      parameter: [{ type: "TEMPLATE", key: "value", value: "live" }],
    }],
    ["a Constant wearing a Data Layer Variable's parameter shape", {
      variableId: "1",
      name: "la_tracking_mode",
      type: "c",
      parameter: [
        { type: "TEMPLATE", key: "name", value: "la_tracking_mode" },
        { type: "TEMPLATE", key: "value", value: "live" },
      ],
    }],
    ["a Custom JavaScript variable", {
      variableId: "1",
      name: "la_tracking_mode",
      type: "jsm",
      parameter: [{ type: "TEMPLATE", key: "javascript", value: "function(){return 'live'}" }],
    }],
    ["a Data Layer Variable reading some other key", {
      variableId: "1",
      name: "la_tracking_mode",
      type: "v",
      parameter: [
        { type: "INTEGER", key: "dataLayerVersion", value: "2" },
        { type: "TEMPLATE", key: "name", value: "something_else" },
      ],
    }],
  ] as const) {
    it(`refuses a container whose mode variable is ${label}`, () => {
      // The guard names a variable; without this it proves only the name. A variable that returns
      // "live" unconditionally satisfies every production guard, and preview sees the same "live".
      const result = auditGtmContainerExport({
        source: containerExport({ variable: [definition] }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.TRACKING_MODE_VARIABLE_NOT_APP_OWNED));
      assert.ok(
        codes(result).includes(GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD),
        "no tag may be certified by a guard whose source is not the application's fact",
      );
    });
  }

  it("refuses a container that defines no mode variable at all", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        variable: [{ variableId: "9", name: "Something else", type: "c", parameter: [] }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.TRACKING_MODE_VARIABLE_NOT_APP_OWNED));
  });

  it("refuses a container that defines the mode variable twice", () => {
    // A reference resolves by name, so two definitions leave the audit reading whichever the index
    // kept — not the one a reviewer read. Ambiguity is now refused structurally, before any rule
    // gets to pick a definition and continue as though the reference had one meaning.
    const result = auditGtmContainerExport({
      source: containerExport({
        variable: [
          trackingModeVariable({ variableId: "2", type: "c", parameter: [
            { type: "TEMPLATE", key: "value", value: "live" },
          ] }),
          trackingModeVariable(),
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("refuses a duplicated destination variable, whichever definition is approved", () => {
    // The unapproved definition comes first and the approved one last. Reading the last would
    // certify the artifact on a reference that no longer has one meaning.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ parameter: [
          { type: "TEMPLATE", key: "measurementId", value: "{{Prod GA4}}" },
          { type: "BOOLEAN", key: "sendPageView", value: "false" },
        ] })],
        variable: [
          trackingModeVariable(),
          constantVariable("Prod GA4", "G-NOTAPPROVED"),
          { ...constantVariable("Prod GA4", "G-FIXTURE001"), variableId: "101" },
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("refuses duplicated settings variables that disagree about page views", () => {
    const settingsVariable = (variableId: string, value: string) => ({
      variableId,
      name: "Config settings",
      type: "gtcs",
      parameter: [{
        type: "LIST",
        key: "configSettingsTable",
        list: [{
          type: "MAP",
          map: [
            { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
            { type: "TEMPLATE", key: "parameterValue", value },
          ],
        }],
      }],
    });
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            { type: "TEMPLATE", key: "configSettingsVariable", value: "{{Config settings}}" },
          ],
        }],
        variable: [
          trackingModeVariable(),
          settingsVariable("101", "true"),
          settingsVariable("102", "false"),
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("refuses a duplicated payload variable before the Meta scan picks one", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "9",
          name: "Vendor snippet",
          type: "html",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [{ type: "TEMPLATE", key: "html", value: "<script>{{Snippet}}</script>" }],
        }],
        variable: [
          trackingModeVariable(),
          constantVariable("Snippet", "fbq('track','Purchase')"),
          { ...constantVariable("Snippet", "console.log('benign')"), variableId: "101" },
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  for (const [label, name] of [
    ["a numeric name", 123],
    ["an empty name", ""],
    ["no name at all", undefined],
  ] as const) {
    it(`refuses a variable with ${label}`, () => {
      const result = auditGtmContainerExport({
        source: containerExport({
          variable: [trackingModeVariable(), { ...constantVariable("x", "y"), name }],
        }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  it("refuses a live-guarded destination tag that another tag sequences", () => {
    // The bypass: a Conversion Linker needs no guard of its own, and a setup tag runs before its
    // primary. The GA4 tag's own live trigger is never evaluated on that path, yet it delivers.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [
          {
            tagId: "5",
            name: "Conversion Linker",
            type: "gclidw",
            firingTriggerId: [ALWAYS_TRIGGER_ID],
            parameter: [],
            setupTag: [{ tagName: "GA4 configuration", stopOnSetupFailure: false }],
          },
          ga4ConfigTag(),
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(
      codes(result).includes(GTM_AUDIT_CODES.TAG_SEQUENCING_NOT_AUDITABLE),
      "a firing path that skips the tag's own trigger must not be invisible to the audit",
    );
  });

  it("refuses a destination tag that sequences another tag after itself", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [
          adsConversionTag({
            teardownTag: [{ tagName: "Conversion Linker", stopTeardownOnFailure: false }],
          }),
          { tagId: "5", name: "Conversion Linker", type: "gclidw", firingTriggerId: [ALWAYS_TRIGGER_ID], parameter: [] },
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.TAG_SEQUENCING_NOT_AUDITABLE));
  });

  it("leaves a container with no tag sequencing alone", () => {
    const result = auditGtmContainerExport({ source: containerExport(), approved: APPROVED });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it("does not read a bare literal as a reference to the mode variable", () => {
    // `la_tracking_mode` without braces is a constant string; GTM would compare it against "live"
    // and never match. Stripping braces before comparing let the audit certify a guard the
    // container does not actually have.
    const literalGuard = {
      triggerId: "13",
      name: "Looks like a guard",
      type: "pageview",
      filter: [{
        type: "equals",
        parameter: [
          { type: "TEMPLATE", key: "arg0", value: "la_tracking_mode" },
          { type: "TEMPLATE", key: "arg1", value: "live" },
        ],
      }],
    };
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ firingTriggerId: ["13"] })],
        trigger: [literalGuard],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD));
  });

  for (const [label, tag] of [
    ["a GA4 configuration tag", ga4ConfigTag({ parameter: [
      { type: "BOOLEAN", key: "sendPageView", value: "false" },
    ] })],
    ["a Google tag", {
      tagId: "1",
      name: "Google tag",
      type: "googtag",
      firingTriggerId: [LIVE_TRIGGER_ID],
      parameter: [{ type: "BOOLEAN", key: "sendPageView", value: "false" }],
    }],
  ] as const) {
    it(`refuses ${label} that names no destination this audit can check`, () => {
      // A configuration tag establishes where the events after it are sent. Checking only the ids
      // it happens to expose would certify one that names its property somewhere this parser does
      // not look — the same proof an Ads conversion already owes about its own action.
      const result = auditGtmContainerExport({
        source: containerExport({ tag: [tag] }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
    });
  }

  it("passes a version whose unmodelled collections are absent or empty", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        zone: [],
        gtagConfig: [],
        client: [],
        transformation: [],
        customTemplate: [],
        builtInVariable: [{ type: "PAGE_URL", name: "Page URL" }],
        folder: [{ folderId: "1", name: "Tracking" }],
      }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it("refuses a zone, which links a whole child container this audit never sees", () => {
    // Every rule in the module reasons about this version's tag[]. A zone's child container has its
    // own tags, which are not in it — so a spotless tag list proves nothing about what actually
    // fires.
    const result = auditGtmContainerExport({
      source: containerExport({
        zone: [{
          zoneId: "1",
          name: "Third party zone",
          childContainer: [{ publicId: "GTM-OTHER", nickname: "partner" }],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAUDITABLE_CONTAINER_FEATURE));
  });

  it("refuses Google tag configuration this audit does not model", () => {
    // gtagConfig changes what the Google tag sends and where, from outside any tag's parameters, so
    // the page-view and destination proofs above cannot speak for it.
    const result = auditGtmContainerExport({
      source: containerExport({
        gtagConfig: [{
          gtagConfigId: "1",
          type: "googtag",
          parameter: [{ type: "TEMPLATE", key: "send_page_view", value: "true" }],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAUDITABLE_CONTAINER_FEATURE));
  });

  for (const key of ["client", "transformation"] as const) {
    it(`refuses a populated ${key} collection`, () => {
      const result = auditGtmContainerExport({
        source: containerExport({ [key]: [{ name: "something" }] }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAUDITABLE_CONTAINER_FEATURE));
    });

    it(`reports a ${key} collection of the wrong shape as malformed`, () => {
      const result = auditGtmContainerExport({
        source: containerExport({ [key]: { name: "something" } }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  it("refuses a collection this audit has never heard of", () => {
    // The gate is an allowlist on purpose: whatever GTM adds after this was written must fail closed
    // rather than pass unnoticed, which is how the zone blind spot happened in the first place.
    const result = auditGtmContainerExport({
      source: containerExport({ somethingGtmAddedLater: [{ fires: "who knows" }] }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAUDITABLE_CONTAINER_FEATURE));
  });

  it("accepts the scalar metadata the published schema defines, by name", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        path: "accounts/0/containers/0/versions/7",
        name: "Reviewed version 7",
        description: "",
        fingerprint: "1699999999999",
        tagManagerUrl: "https://tagmanager.google.com/#/versions/...",
        deleted: false,
      }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  for (const [label, extra] of [
    ["a boolean", { futureRuntimeFlag: true }],
    ["a string", { futureRuntimeMode: "live" }],
    ["a number", { futureRuntimeBudget: 5 }],
    ["null", { futureRuntimeHook: null }],
  ] as const) {
    it(`refuses an unknown top-level field holding ${label}`, () => {
      // Benignness is not a property of a value's type. A future `runtimeMode: "live"` is a scalar
      // and would sail through a gate that only refuses populated arrays and objects — which is
      // exactly the failure this gate exists to stop.
      const result = auditGtmContainerExport({
        source: containerExport(extra),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAUDITABLE_CONTAINER_FEATURE));
    });
  }

  for (const key of ["customTemplate", "folder", "builtInVariable"] as const) {
    it(`reports an inert ${key} collection of the wrong shape as malformed`, () => {
      // An inventory that is not a list is not an inventory, and reading it as absent is a guess.
      const result = auditGtmContainerExport({
        source: containerExport({ [key]: "not-an-array" }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  it("refuses a deleted container version however clean its contents", () => {
    // The question this module answers is whether this exact JSON may be loaded. A deleted version
    // may not, whatever its tags say.
    const result = auditGtmContainerExport({
      source: containerExport({ deleted: true }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.CONTAINER_VERSION_DELETED));
  });

  for (const [label, overrides] of [
    ["a deleted marker that is a string rather than a boolean", { deleted: "true" }],
    ["a numeric accountId", { accountId: 7 }],
    ["a name that is an object", { name: {} }],
    ["a boolean fingerprint", { fingerprint: false }],
  ] as const) {
    it(`refuses ${label}`, () => {
      // A known field name and a plausible-looking value are not a valid schema. `deleted: "true"`
      // is the sharpest case: the deleted check compares against `true`, so a malformed marker
      // would slip past a rule written to catch exactly that state.
      const result = auditGtmContainerExport({
        source: containerExport(overrides),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  for (const key of ["tag", "trigger", "variable", "customTemplate", "folder", "builtInVariable"] as const) {
    it(`refuses a non-object entry inside ${key}[]`, () => {
      // The readers below filter non-objects away. A malformed entry that becomes an ignored entry
      // lets the audit report on a subset of the artifact as though it were the whole.
      const existing = key === "tag"
        ? [ga4ConfigTag()]
        : key === "trigger"
          ? [liveGuardTrigger()]
          : key === "variable"
            ? [trackingModeVariable()]
            : [];
      const result = auditGtmContainerExport({
        source: containerExport({ [key]: [...existing, "garbage"] }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  for (const [label, container] of [
    ["names no usage context", { publicId: "GTM-FIXTURE" }],
    ["names a server container", { publicId: "GTM-FIXTURE", usageContext: ["server"] }],
    ["names an empty usage context", { publicId: "GTM-FIXTURE", usageContext: [] }],
  ] as const) {
    it(`refuses a container that ${label}`, () => {
      // The question is whether the storefront may load this artifact. A server container's export
      // would otherwise satisfy every rule here and be certified for a runtime it was never built
      // for, so being a web container is proved rather than assumed.
      const result = auditGtmContainerExport({
        source: containerExport({ container }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.CONTAINER_NOT_APPROVED));
    });
  }

  it("refuses a guarded and an unguarded trigger sharing one triggerId", () => {
    // The guarded set is keyed by triggerId. With the id declared twice, the definition carrying the
    // live filter vouches for the one that does not, and a tag firing on that id looks guarded.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ firingTriggerId: [LIVE_TRIGGER_ID] })],
        trigger: [
          liveGuardTrigger(),
          { triggerId: LIVE_TRIGGER_ID, name: "All pages", type: "pageview" },
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("refuses two guarded triggers sharing one triggerId", () => {
    // Identity ambiguity does not depend on how the guard check happens to come out.
    const result = auditGtmContainerExport({
      source: containerExport({
        trigger: [liveGuardTrigger(), liveGuardTrigger()],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  for (const [label, triggerId] of [
    ["a numeric triggerId", 123],
    ["an empty triggerId", ""],
    ["no triggerId at all", undefined],
  ] as const) {
    it(`refuses a trigger with ${label}`, () => {
      const result = auditGtmContainerExport({
        source: containerExport({
          trigger: [{ ...liveGuardTrigger(), triggerId }],
        }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  for (const [label, firingTriggerId] of [
    ["a non-string entry", [LIVE_TRIGGER_ID, 123]],
    ["an empty-string entry", [LIVE_TRIGGER_ID, ""]],
    ["a value that is not an array", LIVE_TRIGGER_ID],
  ] as const) {
    it(`refuses a tag whose firingTriggerId holds ${label}`, () => {
      // Filtering the bad entry away would decide "guarded" from a firing list the artifact does not
      // actually have — malformed data becoming ignored data at exactly the deciding point.
      const result = auditGtmContainerExport({
        source: containerExport({ tag: [ga4ConfigTag({ firingTriggerId })] }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  for (const [label, usageContext] of [
    ["a non-string entry beside web", ["web", 123]],
    ["a context this audit cannot read", ["web", "futureRuntime"]],
    ["a value that is not an array", "web"],
  ] as const) {
    it(`refuses a container whose usageContext holds ${label}`, () => {
      // The nested container is an approval boundary, so what it declares has to be readable in full
      // before any part of it counts as proof of a web container.
      const result = auditGtmContainerExport({
        source: containerExport({ container: { publicId: "GTM-FIXTURE", usageContext } }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  it("accepts a container that serves web alongside another known context", () => {
    // Usage contexts name the platforms a container serves, not exclusions, so web remains proved.
    // This is a policy decision rather than a fact read from an artifact, and it is recorded as one.
    const result = auditGtmContainerExport({
      source: containerExport({
        container: { publicId: "GTM-FIXTURE", usageContext: ["web", "amp"] },
      }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it("refuses a settings row that declares one cell key twice", () => {
    // A row is read as a key -> value table, so a repeated key keeps whichever cell came last:
    // `parameterValue: "true"` then `"false"` would prove page views disabled by cell order alone.
    // A row that says two things about one key says nothing about it.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [{
          tagId: "1",
          name: "Google tag",
          type: "googtag",
          firingTriggerId: [LIVE_TRIGGER_ID],
          parameter: [
            { type: "TEMPLATE", key: "tagId", value: "G-FIXTURE001" },
            {
              type: "LIST",
              key: "configSettingsTable",
              list: [{
                type: "MAP",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                  { type: "TEMPLATE", key: "parameterValue", value: "true" },
                  { type: "TEMPLATE", key: "parameterValue", value: "false" },
                ],
              }],
            },
          ],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    assert.ok(
      !codes(result).includes(GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW),
      "the row must be refused as unreadable, not resolved to one of its two answers",
    );
  });

  it("refuses a repeated cell key inside a variable's parameter rows", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        variable: [trackingModeVariable(), {
          variableId: "101",
          name: "Config settings",
          type: "gtcs",
          parameter: [{
            type: "LIST",
            key: "configSettingsTable",
            list: [{
              type: "MAP",
              map: [
                { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                { type: "TEMPLATE", key: "parameter", value: "something_else" },
              ],
            }],
          }],
        }],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("refuses two tags that share a name", () => {
    // Sequencing edges name their partner by tagName, so a name has to identify one tag.
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4EventTag({ tagId: "3" }), ga4EventTag({ tagId: "4" })],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("refuses a tag with no usable name", () => {
    const result = auditGtmContainerExport({
      source: containerExport({ tag: [ga4ConfigTag({ name: "" })] }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  for (const [label, edges] of [
    ["names a tag that is not in this version", [{ tagName: "Ghost", stopOnSetupFailure: false }]],
    ["names nothing at all", [{ stopOnSetupFailure: false }]],
    ["holds an entry that is not an object", ["Ghost"]],
    ["is not an array", { tagName: "Conversion Linker" }],
  ] as const) {
    it(`refuses a sequencing edge that ${label}`, () => {
      // An edge the audit cannot follow is a firing path it cannot account for. Passing over it
      // would be the same "unresolvable reference becomes an ignored reference" this module has
      // had to be corrected on repeatedly.
      const result = auditGtmContainerExport({
        source: containerExport({
          tag: [
            { tagId: "5", name: "Conversion Linker", type: "gclidw", firingTriggerId: [LIVE_TRIGGER_ID], parameter: [], setupTag: edges },
            ga4ConfigTag(),
          ],
        }),
        approved: APPROVED,
      });

      assert.equal(result.ok, false);
      assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    });
  }

  it("refuses a container object whose publicId is not a string", () => {
    const result = auditGtmContainerExport({
      source: containerExport({ container: { publicId: 12345, usageContext: ["web"] } }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("refuses a version that disagrees with its own container about which container it is", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        accountId: "1",
        containerId: "2",
        container: { publicId: "GTM-FIXTURE", usageContext: ["web"], accountId: "1", containerId: "999" },
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
  });

  it("accepts a version whose nested container agrees with it", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        accountId: "1",
        containerId: "2",
        container: { publicId: "GTM-FIXTURE", usageContext: ["web"], accountId: "1", containerId: "2" },
      }),
      approved: APPROVED,
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it("does not run the semantic rules on a version whose shape it has refused", () => {
    // Reporting tag-level findings about a version the audit has just said it cannot read would be
    // certifying a normalised artifact rather than the one on disk.
    const result = auditGtmContainerExport({
      source: containerExport({
        deleted: "true",
        tag: [ga4ConfigTag({ firingTriggerId: [ALWAYS_TRIGGER_ID], parameter: [] })],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.MALFORMED_EXPORT));
    assert.ok(
      !codes(result).includes(GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD),
      "semantic findings must not be reported about a version the audit could not read",
    );
  });

  it("refuses an export from a container the owner did not approve", () => {
    // Same destination ids, different container: without this the audit would certify an artifact
    // that was never the reviewed one.
    const result = auditGtmContainerExport({
      source: containerExport({ container: { publicId: "GTM-SOMEONEELSE", usageContext: ["web"] } }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.CONTAINER_NOT_APPROVED));
  });

  it("fails a destination id the owner has not approved", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [ga4ConfigTag({ parameter: [
          { type: "TEMPLATE", key: "measurementId", value: "G-NOTAPPROVED" },
          { type: "BOOLEAN", key: "sendPageView", value: "false" },
        ] })],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.UNAPPROVED_DESTINATION));
  });

  it("fails closed when no destination has been approved at all", () => {
    // Owner gate O4. With no reviewed vendor ids there is nothing to compare against, and an audit
    // that passed here would be certifying an unreviewed container.
    const result = auditGtmContainerExport({
      source: containerExport(),
      approved: {
        gtmContainerId: "GTM-FIXTURE",
        ga4MeasurementIds: [],
        googleAdsConversions: [],
        tiktokPixelIds: [],
      },
    });

    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(GTM_AUDIT_CODES.NO_APPROVED_DESTINATIONS));
  });

  it("reports every violation in one pass rather than stopping at the first", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        containerVersionId: "0",
        tag: [
          ga4ConfigTag({ firingTriggerId: [ALWAYS_TRIGGER_ID], parameter: [
            { type: "TEMPLATE", key: "measurementId", value: "G-NOTAPPROVED" },
          ] }),
          { tagId: "8", name: "Facebook Pixel", type: "cvt_meta_pixel", firingTriggerId: [LIVE_TRIGGER_ID], parameter: [] },
        ],
      }),
      approved: APPROVED,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [
      GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW,
      GTM_AUDIT_CODES.META_TAG_PRESENT,
      GTM_AUDIT_CODES.NOT_A_SAVED_VERSION,
      GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD,
      GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
      GTM_AUDIT_CODES.UNAUDITABLE_TAG_TYPE,
    ].sort());
  });
});

describe("calibration against the first real saved export", () => {
  it("reads the upper-case usage contexts a real export carries, and still refuses an unknown one", () => {
    const accepted = auditGtmContainerExport({
      source: containerExport({ container: { publicId: "GTM-FIXTURE", usageContext: ["WEB"] } }),
      approved: APPROVED,
    });
    assert.deepEqual(codes(accepted), []);

    const androidSdk = auditGtmContainerExport({
      source: containerExport({ container: { publicId: "GTM-FIXTURE", usageContext: ["WEB", "ANDROID_SDK_5"] } }),
      approved: APPROVED,
    });
    assert.deepEqual(codes(androidSdk), []);

    const unknown = auditGtmContainerExport({
      source: containerExport({ container: { publicId: "GTM-FIXTURE", usageContext: ["WEB", "FRIDGE"] } }),
      approved: APPROVED,
    });
    assert.deepEqual(codes(unknown), [GTM_AUDIT_CODES.MALFORMED_EXPORT]);
  });

  const googleTag = (tagId: string, overrides: Record<string, unknown> = {}) => ({
    tagId: "9",
    name: "Google tag",
    type: "googtag",
    firingTriggerId: [LIVE_TRIGGER_ID],
    parameter: [
      { type: "TEMPLATE", key: "tagId", value: tagId },
      { type: "BOOLEAN", key: "sendPageView", value: "false" },
    ],
    ...overrides,
  });

  it("accepts a Google tag naming an approved Google Ads account, written with or without the AW- prefix", () => {
    const result = auditGtmContainerExport({
      source: containerExport({ tag: [googleTag("AW-FIXTURE001")] }),
      approved: APPROVED,
    });
    assert.deepEqual(codes(result), []);

    const bareApproval = auditGtmContainerExport({
      source: containerExport({ tag: [googleTag("AW-17016425181")] }),
      approved: {
        ...APPROVED,
        googleAdsConversions: [{ conversionId: "17016425181", conversionLabel: "FixtureLabel01" }],
      },
    });
    assert.deepEqual(codes(bareApproval), []);
  });

  it("refuses a Google tag naming a Google Ads account nobody approved", () => {
    const result = auditGtmContainerExport({
      source: containerExport({ tag: [googleTag("AW-OTHERACCOUNT")] }),
      approved: APPROVED,
    });
    assert.deepEqual(codes(result), [GTM_AUDIT_CODES.UNAPPROVED_DESTINATION]);
  });

  it("still treats a G- id on a Google tag as a GA4 property that must be approved", () => {
    const approved = auditGtmContainerExport({
      source: containerExport({ tag: [googleTag("G-FIXTURE001")] }),
      approved: APPROVED,
    });
    assert.deepEqual(codes(approved), []);

    const unapproved = auditGtmContainerExport({
      source: containerExport({ tag: [googleTag("G-UNREVIEWED")] }),
      approved: APPROVED,
    });
    assert.deepEqual(codes(unapproved), [GTM_AUDIT_CODES.UNAPPROVED_DESTINATION]);
  });

  it("does not let the AW- allowance excuse a Google tag that still sends automatic page views", () => {
    const result = auditGtmContainerExport({
      source: containerExport({
        tag: [googleTag("AW-FIXTURE001", { parameter: [{ type: "TEMPLATE", key: "tagId", value: "AW-FIXTURE001" }] })],
      }),
      approved: APPROVED,
    });
    assert.deepEqual(codes(result), [GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW]);
  });
});

