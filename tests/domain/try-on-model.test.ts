import assert from "node:assert/strict";
import test from "node:test";

import { TRY_ON_FAILURE_REASONS } from "../../src/commerce/try-on-policy.ts";
import {
  TRY_ON_AGE_OPTIONS,
  TRY_ON_LIKENESS_ACKNOWLEDGEMENT,
  isBlockedAgeState,
  isFinalForPhoto,
  isTeenAgeState,
  isTryOnAgeAllowed,
  missingTryOnSteps,
  tryOnFailureMessage,
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
  assert.match(tryOnFailureMessage("DAILY_LIMIT_REACHED"), /hôm nay|ngày mai/);
  assert.match(tryOnFailureMessage("RATE_LIMITED"), /1 phút/);
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
