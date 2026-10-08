import assert from "node:assert/strict";
import test from "node:test";

import { TRY_ON_FAILURE_REASONS } from "../../src/commerce/try-on-policy.ts";
import {
  TRY_ON_AGE_OPTIONS,
  TRY_ON_BETA_NOTE,
  TRY_ON_LIKENESS_ACKNOWLEDGEMENT,
  TRY_ON_PHOTO_DONTS,
  TRY_ON_PHOTO_DOS,
  TRY_ON_WAIT_NOTE,
  isBlockedAgeState,
  isFinalForPhoto,
  isTeenAgeState,
  isTryOnAgeAllowed,
  missingTryOnSteps,
  nextTryOnStep,
  parseTryOnQuota,
  tryOnLoginHref,
  tryOnQuotaLine,
  tryOnStepNumber,
  TRY_ON_TEEN_ATTESTATION_LEAD,
  tryOnFailureMessage,
  tryOnQuotaUpsell,
  tryOnUploadSize,
  validateTryOnFile,
} from "../../src/components/headless/try-on-model.ts";

test("the likeness acknowledgement is the exact approved sentence", () => {
  assert.equal(
    TRY_ON_LIKENESS_ACKNOWLEDGEMENT,
    "Tôi xác nhận đây là ảnh của tôi hoặc tôi có sự đồng ý rõ ràng và các quyền cần thiết để sử dụng hình ảnh của người trong ảnh cho tính năng thử đồ này.",
  );
});

test("the three age options map one-to-one to the three server age states", () => {
  assert.deepEqual(
    TRY_ON_AGE_OPTIONS.map((option) => option.value),
    ["adult", "teen_eligible_with_guardian", "below_digital_consent_age"],
  );
});

test("the teen option carries the age range, digital-consent age and guardian attestations together", () => {
  const teen = TRY_ON_AGE_OPTIONS.find((option) => option.value === "teen_eligible_with_guardian")!;
  assert.match(teen.label, /từ 13 đến 17 tuổi/);
  assert.match(teen.label, /đã đủ tuổi đồng ý xử lý dữ liệu số theo quy định nơi tôi sống/);
  assert.match(teen.label, /sự cho phép của cha mẹ hoặc người giám hộ hợp pháp/);
});

test("age predicates: only the blocked state is refused, only the teen state shows the disclosure", () => {
  assert.equal(isTryOnAgeAllowed(null), false);
  assert.equal(isTryOnAgeAllowed("adult"), true);
  assert.equal(isTryOnAgeAllowed("teen_eligible_with_guardian"), true);
  assert.equal(isTryOnAgeAllowed("below_digital_consent_age"), false);
  assert.equal(isTeenAgeState("teen_eligible_with_guardian"), true);
  assert.equal(isTeenAgeState("adult"), false);
  assert.equal(isBlockedAgeState("below_digital_consent_age"), true);
  assert.equal(isBlockedAgeState(null), false);
});

test("every server failure reason has a safe Vietnamese message with no upstream detail", () => {
  for (const reason of TRY_ON_FAILURE_REASONS) {
    const message = tryOnFailureMessage(reason);
    assert.ok(message.length > 0, reason);
    assert.doesNotMatch(message, /vertex|google|rai|token|credential|projects\//i, reason);
  }
  assert.equal(tryOnFailureMessage("something unexpected"), tryOnFailureMessage("GENERATION_FAILED"));
  assert.equal(tryOnFailureMessage(undefined), tryOnFailureMessage("GENERATION_FAILED"));
});

test("login-required tells a guest to sign in; the daily limit tells a member to come back tomorrow", () => {
  assert.match(tryOnFailureMessage("LOGIN_REQUIRED"), /đăng nhập/);
  assert.match(tryOnFailureMessage("LOGIN_REQUIRED"), /5 lượt/);
  assert.match(tryOnFailureMessage("DAILY_LIMIT_REACHED"), /hôm nay|ngày mai/i);
  assert.match(tryOnFailureMessage("RATE_LIMITED"), /1 phút/);
});

test("the limit messages are gentle, state the numbers, and say what to do next", () => {
  assert.match(tryOnFailureMessage("RATE_LIMITED"), /nhé/);
  assert.match(tryOnFailureMessage("LOGIN_REQUIRED"), /Tạo tài khoản hoặc đăng nhập/);
  assert.match(tryOnFailureMessage("DAILY_LIMIT_REACHED"), /10 lượt/);
  assert.match(tryOnFailureMessage("DAILY_LIMIT_REACHED"), /24 giờ/);
});

test("only a guest who hit an allowance limit is offered an account, and the copy states both allowances", () => {
  for (const [reason, audience] of [
    ["LOGIN_REQUIRED", null],
    ["LOGIN_REQUIRED", "guest"],
    ["RATE_LIMITED", "guest"],
  ] as const) {
    const upsell = tryOnQuotaUpsell(reason, audience);
    assert.ok(upsell, `${reason}/${audience}`);
    assert.match(upsell.body, /5 lượt/);
    assert.match(upsell.body, /10 lượt/);
  }
  // A signed-in shopper is never told to sign up; "too soon" is not offered until the server has said who asks.
  assert.equal(tryOnQuotaUpsell("RATE_LIMITED", "member"), null);
  assert.equal(tryOnQuotaUpsell("LOGIN_REQUIRED", "member"), null);
  assert.equal(tryOnQuotaUpsell("RATE_LIMITED", null), null);
  for (const reason of [null, "BUSY", "DAILY_LIMIT_REACHED", "GENERATION_FAILED"] as const) {
    assert.equal(tryOnQuotaUpsell(reason, "guest"), null, String(reason));
  }
});

test("the quota body from the server is read strictly; anything else shows no number", () => {
  assert.deepEqual(parseTryOnQuota({ ok: true, audience: "guest", limit: 5, remaining: 3 }), {
    audience: "guest",
    limit: 5,
    remaining: 3,
  });
  for (const bad of [
    null,
    "x",
    {},
    { ok: false },
    { ok: true, audience: "admin", limit: 5, remaining: 3 },
    { ok: true, audience: "guest", limit: "5", remaining: 3 },
    { ok: true, audience: "guest", limit: 5, remaining: -1 },
    { ok: true, audience: "guest", limit: 5.5, remaining: 1 },
  ]) {
    assert.equal(parseTryOnQuota(bad), null, JSON.stringify(bad));
  }
});

test("the first-step quota line: a guest is told what an account adds, a member just what is left", () => {
  assert.equal(tryOnQuotaLine(null), null);
  assert.match(tryOnQuotaLine({ audience: "guest", limit: 5, remaining: 5 })!, /còn 5\/5 lượt thử đồ miễn phí/);
  assert.match(tryOnQuotaLine({ audience: "guest", limit: 5, remaining: 5 })!, /10 lượt mỗi ngày/);
  assert.match(tryOnQuotaLine({ audience: "guest", limit: 5, remaining: 0 })!, /đã dùng hết/);
  assert.equal(tryOnQuotaLine({ audience: "member", limit: 10, remaining: 8 }), "Hôm nay bạn còn 8/10 lượt thử đồ.");
});

test("the sign-in link returns to this product and nowhere else", () => {
  assert.equal(tryOnLoginHref("set-quan-ha-lam"), "/login?next=%2Fshop%2Fset-quan-ha-lam");
});

test("the wait and in-development notices say what the shopper needs to know", () => {
  assert.match(TRY_ON_WAIT_NOTE, /30–60 giây/);
  assert.match(TRY_ON_BETA_NOTE, /đang được .*hoàn thiện/);
  assert.ok(TRY_ON_PHOTO_DOS.length > 0 && TRY_ON_PHOTO_DONTS.length > 0);
});

test("only a safety block makes the photo final", () => {
  assert.equal(isFinalForPhoto("SAFETY_BLOCKED"), true);
  for (const reason of TRY_ON_FAILURE_REASONS.filter((value) => value !== "SAFETY_BLOCKED")) {
    assert.equal(isFinalForPhoto(reason), false, reason);
  }
});

test("local file validation mirrors the server limits (JPEG/PNG, at most 7 MB)", () => {
  assert.equal(validateTryOnFile({ type: "image/jpeg", size: 1 }), null);
  assert.equal(validateTryOnFile({ type: "image/png", size: 7 * 1024 * 1024 }), null);
  assert.match(validateTryOnFile({ type: "image/png", size: 7 * 1024 * 1024 + 1 })!, /7 MB/);
  for (const type of ["image/webp", "image/gif", "application/pdf", ""]) {
    assert.match(validateTryOnFile({ type, size: 1 })!, /JPG hoặc PNG/);
  }
});

test("the missing-steps hint lists what remains in fill-in order", () => {
  assert.deepEqual(missingTryOnSteps({ hasPhoto: false, ageState: null, acknowledged: false }), [
    "chọn ảnh",
    "chọn độ tuổi",
    "xác nhận quyền sử dụng hình ảnh",
  ]);
  assert.deepEqual(missingTryOnSteps({ hasPhoto: true, ageState: "adult", acknowledged: false }), [
    "xác nhận quyền sử dụng hình ảnh",
  ]);
  assert.deepEqual(missingTryOnSteps({ hasPhoto: true, ageState: "adult", acknowledged: true }), []);
});

test("each age option has a short chip label next to its full statement", () => {
  assert.deepEqual(
    TRY_ON_AGE_OPTIONS.map((option) => option.shortLabel),
    ["Từ 18 tuổi", "13–17 tuổi", "Chưa đủ tuổi"],
  );
  // The chip is only a label: the full statement stays the thing the shopper attests to.
  for (const option of TRY_ON_AGE_OPTIONS) assert.ok(option.label.length > option.shortLabel.length);
  assert.match(TRY_ON_TEEN_ATTESTATION_LEAD, /xác nhận/);
});

test("the three wizard steps are numbered 1 to 3", () => {
  assert.equal(tryOnStepNumber("photo"), 1);
  assert.equal(tryOnStepNumber("confirm"), 2);
  assert.equal(tryOnStepNumber("result"), 3);
});

test("step transitions: forward through the wizard, back where it is safe, photo on a final refusal", () => {
  assert.equal(nextTryOnStep("photo", "continue"), "confirm");
  assert.equal(nextTryOnStep("confirm", "generate"), "result");
  assert.equal(nextTryOnStep("confirm", "change-photo"), "photo");
  assert.equal(nextTryOnStep("result", "back"), "confirm");
  assert.equal(nextTryOnStep("result", "change-photo"), "photo");
  // A photo the provider refused is dropped wherever the shopper is, and they go back to choose another.
  for (const step of ["photo", "confirm", "result"] as const) {
    assert.equal(nextTryOnStep(step, "photo-dropped"), "photo");
  }
  // Events that make no sense for a step leave it where it is (no skipping the confirmation step).
  assert.equal(nextTryOnStep("photo", "generate"), "photo");
  assert.equal(nextTryOnStep("photo", "back"), "photo");
  assert.equal(nextTryOnStep("confirm", "continue"), "confirm");
  assert.equal(nextTryOnStep("result", "continue"), "result");
});

test("the upload is scaled so its long side is 1200px, keeping proportions, and never enlarged", () => {
  assert.deepEqual(tryOnUploadSize(4032, 3024), { width: 1200, height: 900 });
  assert.deepEqual(tryOnUploadSize(3024, 4032), { width: 900, height: 1200 });
  assert.deepEqual(tryOnUploadSize(1200, 800), { width: 1200, height: 800 });
  assert.deepEqual(tryOnUploadSize(640, 480), { width: 640, height: 480 });
  assert.deepEqual(tryOnUploadSize(20000, 1), { width: 1200, height: 1 });
});
