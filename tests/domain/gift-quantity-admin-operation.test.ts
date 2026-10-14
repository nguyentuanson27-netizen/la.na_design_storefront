import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AuthorizationError } from "../../src/auth/authorization.ts";
import {
  describeGiftQuantityFailure,
  describeGiftQuantityReason,
  GIFT_QUANTITY_RENDERABLE_REASONS,
  type GiftQuantityFailure,
} from "../../src/commerce/gift-quantity-admin-feedback.ts";
import {
  GIFT_QUANTITY_ADMIN_OPERATIONS,
  runGiftQuantityAdminOperation,
  type GiftQuantityRefusalSignal,
} from "../../src/operations/gift-quantity-admin-operation.ts";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const actionsSource = source("../../src/app/admin/promotions/gift-quantity/actions.ts");
const funnelSource = source("../../src/operations/gift-quantity-admin-operation.ts");

function actionSource(name: string): string {
  const marker = `export async function ${name}`;
  const start = actionsSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = actionsSource.indexOf("\nexport async function ", start + marker.length);
  return actionsSource.slice(start, next === -1 ? actionsSource.length : next);
}

test("nothing the caller supplied is parsed or acted on until authorize() has resolved", () => {
  const authorizeAt = funnelSource.indexOf("session = await authorize();");
  const runAt = funnelSource.indexOf("await run(session)");
  assert.ok(authorizeAt >= 0 && runAt > authorizeAt, "the funnel must authorize before running the operation");
  assert.match(actionsSource, /authorize: \(\) => requireCurrentAdmin\(\),/);
  assert.match(actionsSource, /\brun,/);

  for (const name of ["createGiftQuantityAction", "editGiftQuantityAction"]) {
    const body = actionSource(name);
    // FormData is parsed inside the authorized callback, never before it.
    assert.match(body, /runOperation\(\s*"[a-z-]+",\s*async \(session\) => \{/, `${name} must run its work inside the authorized callback`);
    assert.ok(body.indexOf("runOperation(") < body.indexOf("parseGiftQuantityDraftForm(formData)"), `${name} must parse after authorization`);
  }
});

const CONTRACT = {
  createGiftQuantityAction: { operation: "create", service: "createDraftGiftQuantityCampaign" },
  editGiftQuantityAction: { operation: "edit", service: "editDraftGiftQuantityCampaign" },
  publishGiftQuantityAction: { operation: "publish", service: "publishGiftQuantityCampaign" },
  disableGiftQuantityAction: { operation: "disable", service: "disableGiftQuantityCampaign" },
  endGiftQuantityEarlyAction: { operation: "end-early", service: "endGiftQuantityCampaignEarly" },
  copyGiftQuantityAction: { operation: "copy", service: "copyGiftQuantityCampaign" },
  setLegacyStackConsentAction: { operation: "set-legacy-consent", service: "setLegacyPromotionStackConsent" },
  clearLegacyStackConsentAction: { operation: "clear-legacy-consent", service: "clearLegacyPromotionStackConsent" },
} as const;

test("every action reports under its own operation label and calls its own service", () => {
  for (const [action, { operation, service }] of Object.entries(CONTRACT)) {
    const body = actionSource(action);
    const labels = [...body.matchAll(/runOperation\(\s*"([a-z-]+)"/g)].map((match) => match[1]);
    assert.deepEqual(labels, [operation], `${action} must report as "${operation}" only`);
    assert.ok(body.includes(`${service}(`), `${action} must call ${service}`);
  }
  // the scheduled edit is reached from the edit action only, for a Scheduled campaign
  assert.ok(actionSource("editGiftQuantityAction").includes("editScheduledGiftQuantityCampaign("));
  const covered = new Set<string>([...Object.values(CONTRACT).map((entry) => entry.operation), "edit-scheduled"]);
  assert.deepEqual(covered, new Set(GIFT_QUANTITY_ADMIN_OPERATIONS), "the closed vocabulary is exactly what the actions produce");
});

test("the read-only helpers authorize before touching anything and fail closed to an empty answer", () => {
  for (const name of ["searchGiftQuantityProductsAction", "previewGiftQuantityScopeAction"]) {
    const body = actionSource(name);
    assert.ok(body.indexOf("requireCurrentAdmin()") >= 0 && body.indexOf("requireCurrentAdmin()") < body.indexOf("repository"), `${name} must authorize first`);
    assert.match(body, /catch \{\s*return (\[\]|null);/, `${name} must return an empty answer for a non-admin`);
  }
});

const noSession = Symbol("session");

test("an unauthenticated or non-admin caller gets FORBIDDEN, the run callback never executes, and no signal is emitted", async () => {
  for (const code of ["UNAUTHENTICATED", "FORBIDDEN"] as const) {
    let ran = false;
    const signals: GiftQuantityRefusalSignal[] = [];
    const outcome = await runGiftQuantityAdminOperation({
      operation: "create",
      authorize: async () => { throw new AuthorizationError(code); },
      run: async () => { ran = true; return { ok: true }; },
      onCommitted: () => { ran = true; },
      emit: (signal) => signals.push(signal),
    });
    assert.equal(ran, false);
    assert.deepEqual(signals, []);
    assert.equal(!outcome.ok && outcome.failure.reason, "FORBIDDEN", code);
  }
});

test("a fault that is not an authorization error propagates instead of being rendered as a form message", async () => {
  await assert.rejects(
    runGiftQuantityAdminOperation({ operation: "create", authorize: async () => { throw new Error("db down"); }, run: async () => ({ ok: true }), onCommitted: () => undefined }),
    /db down/,
  );
  await assert.rejects(
    runGiftQuantityAdminOperation({ operation: "create", authorize: async () => noSession, run: async () => { throw new Error("write failed"); }, onCommitted: () => undefined }),
    /write failed/,
  );
});

test("success invalidates the cache; refusal does not, and emits only a categorical signal", async () => {
  let committed = 0;
  const signals: GiftQuantityRefusalSignal[] = [];
  const ok = await runGiftQuantityAdminOperation({ operation: "publish", authorize: async () => noSession, run: async () => ({ ok: true }), onCommitted: () => { committed += 1; }, emit: (s) => signals.push(s) });
  assert.deepEqual(ok, { ok: true });
  assert.equal(committed, 1);

  const refused = await runGiftQuantityAdminOperation({
    operation: "publish", authorize: async () => noSession, onCommitted: () => { committed += 1; }, emit: (s) => signals.push(s),
    run: async () => ({ ok: false, failure: { reason: "INVALID_SCOPE", issues: [{ code: "scope-product-id-invalid", field: "productIds" }] } }),
  });
  assert.equal(committed, 1, "a refusal commits nothing and invalidates nothing");
  assert.deepEqual(signals, [{ event: "gift_quantity_admin_refused", operation: "publish", reason: "INVALID_SCOPE" }]);
  assert.equal(JSON.stringify(signals).includes("productIds"), false, "no payload detail in the signal");
  assert.equal(!refused.ok && refused.failure.wroteNothing, true);
});

test("every failure reason has a Vietnamese sentence and no payload (ids, codes, constraint names) leaks into it", () => {
  const failures: GiftQuantityFailure[] = [
    { reason: "FEATURE_DISABLED" },
    { reason: "CAMPAIGN_NOT_FOUND" },
    { reason: "ILLEGAL_TRANSITION", from: "ACTIVE" },
    { reason: "INVALID_INPUT", errors: ["EMPTY_NAME"] },
    { reason: "INVALID_INPUT", errors: ["SOMETHING_UNKNOWN_cm0x9secret"] },
    { reason: "INVALID_SCOPE", issues: [{ code: "scope-global-with-targets", field: "scope" }] },
    { reason: "INVALID_SCOPE", issues: [{ code: "scope-product-id-invalid", field: "productIds" }] },
    { reason: "INVALID_RULE", errors: ["RULE_VALIDATION_NOT_AVAILABLE"] },
    { reason: "FROZEN_SET_INVALID", code: "scope-frozen-empty" },
    { reason: "FROZEN_SET_INVALID", code: "scope-frozen-too-many" },
    { reason: "KIND_IMMUTABLE" },
    { reason: "INVALID_KIND" },
    { reason: "INVALID_SCOPE_MODE" },
    { reason: "INVALID_GIFT_TRIGGER" },
    { reason: "INVALID_SUBTOTAL_SCOPE" },
    { reason: "INVALID_DATE_TIME" },
    { reason: "FORBIDDEN" },
  ];
  for (const failure of failures) {
    const described = describeGiftQuantityFailure(failure);
    assert.ok(described.message.length > 10, failure.reason);
    assert.equal(described.wroteNothing, true);
    assert.equal(/cm0x9secret|SQL|constraint|_check|P20\d\d|[a-z]+-[a-z]+-[a-z]+/.test(described.message.replace(/[–—-]+/g, " ")), false, `${failure.reason}: ${described.message}`);
  }
  assert.match(describeGiftQuantityFailure({ reason: "INVALID_INPUT", errors: ["SOMETHING_UNKNOWN_cm0x9secret"] }).message, /chưa hợp lệ/);
});

test("the URL-carried reason is only rendered when it is a known typed reason", () => {
  assert.ok(describeGiftQuantityReason("FEATURE_DISABLED"));
  assert.equal(describeGiftQuantityReason("<script>alert(1)</script>"), null);
  assert.equal(describeGiftQuantityReason("constructor"), null);
  assert.equal(describeGiftQuantityReason("__proto__"), null);
  assert.ok(GIFT_QUANTITY_RENDERABLE_REASONS.has("FORBIDDEN"));
});
