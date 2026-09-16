import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkoutSubmitFeedback } from "../../src/commerce/checkout-submit-feedback.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("confirmed checkout feedback surfaces the order code", () => {
  assert.deepEqual(
    checkoutSubmitFeedback({ ok: true, status: "CONFIRMED", orderCode: "LA-123" }),
    {
      tone: "success",
      title: "Đặt hàng thành công",
      message: "Mã đơn LA-123. La.na Design sẽ liên hệ để xác nhận đơn COD.",
      mayRetry: false,
    },
  );
});

test("processing and sync-unknown feedback never suggests a blind resubmit", () => {
  for (const result of [
    { ok: false as const, status: "PROCESSING" as const, orderCode: "LA-456" },
    { ok: false as const, status: "SYNC_UNKNOWN" as const, orderCode: "LA-789" },
  ]) {
    const feedback = checkoutSubmitFeedback(result);
    assert.equal(feedback.mayRetry, false);
    assert.match(feedback.message, /không gửi lại/i);
    assert.match(feedback.message, new RegExp(result.orderCode));
  }
});

test("retryable checkout feedback uses Giỏ hàng for cart drift and unavailable-cart recovery", () => {
  assert.deepEqual(
    checkoutSubmitFeedback({ ok: false, status: "RETRYABLE", reason: "INVALID_INPUT" }),
    {
      tone: "error",
      title: "Kiểm tra lại thông tin",
      message: "Địa chỉ hoặc thông tin nhận hàng chưa hợp lệ. Hãy chọn lại đầy đủ tỉnh/thành, quận/huyện và phường/xã.",
      mayRetry: true,
    },
  );

  assert.deepEqual(
    checkoutSubmitFeedback({ ok: false, status: "RETRYABLE", reason: "CART_CHANGED" }),
    {
      tone: "warning",
      title: "Giỏ hàng đã thay đổi",
      message: "Giá hoặc tồn kho đã thay đổi. Hãy quay lại giỏ hàng để kiểm tra trước khi đặt lại.",
      mayRetry: false,
    },
  );

  assert.deepEqual(
    checkoutSubmitFeedback({ ok: false, status: "RETRYABLE", reason: "CART_UNAVAILABLE" }),
    {
      tone: "warning",
      title: "Giỏ hàng không còn sẵn sàng",
      message: "Giỏ hàng hiện không thể thanh toán. Hãy quay lại giỏ hàng và kiểm tra sản phẩm.",
      mayRetry: false,
    },
  );

  assert.equal(
    checkoutSubmitFeedback({ ok: false, status: "RETRYABLE", reason: "CHECKOUT_UNAVAILABLE" }).mayRetry,
    true,
  );
});

test("guest checkout recovery link uses Giỏ hàng terminology", async () => {
  const source = await readFile(
    join(REPO_ROOT, "src/components/commerce/guest-checkout-form.tsx"),
    "utf8",
  );

  assert.equal(source.includes("Quay lại giỏ hàng"), true);
  assert.equal(source.includes("Quay lại túi hàng"), false);
});
