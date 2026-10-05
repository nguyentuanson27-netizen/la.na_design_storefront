import assert from "node:assert/strict";
import test from "node:test";

import { resolveTryOnPrivacyDisclosure } from "../../src/components/headless/try-on-disclosure.ts";

test("Vertex disclosure preserves the existing Google Cloud boundary", () => {
  const copy = resolveTryOnPrivacyDisclosure("vertex", "La.na Design");
  assert.match(copy.summary, /Google Cloud Vertex AI/);
  assert.match(copy.detail, /thiết lập kiểm soát dữ liệu/);
  assert.doesNotMatch(copy.detail, /dự án\/lịch sử/);
});

test("Flow disclosure names Flow project/history instead of making a zero-retention promise", () => {
  const copy = resolveTryOnPrivacyDisclosure("flow", "La.na Design");
  assert.match(copy.summary, /Google Flow/);
  assert.match(copy.detail, /dự án\/lịch sử/);
  assert.match(copy.detail, /có thể xuất hiện/);
  assert.doesNotMatch(copy.detail, /Vertex AI/);
  assert.doesNotMatch(copy.detail, /xóa ngay|deleted immediately/i);
});
