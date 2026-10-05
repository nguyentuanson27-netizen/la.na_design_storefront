import assert from "node:assert/strict";
import test from "node:test";

import { resolveTryOnPrivacyDisclosure } from "../../src/components/headless/try-on-disclosure.ts";

test("Vertex disclosure preserves the existing Google Cloud boundary", () => {
  const copy = resolveTryOnPrivacyDisclosure("vertex", "La.na Design");
  assert.match(copy.summary, /Google Cloud Vertex AI/);
  assert.match(copy.detail, /thiết lập kiểm soát dữ liệu/);
  assert.doesNotMatch(copy.detail, /dự án\/lịch sử/);
});

test("Flow disclosure scopes the no-store claim and names persistent browser storage", () => {
  const copy = resolveTryOnPrivacyDisclosure("flow", "La.na Design");
  assert.match(copy.summary, /Google Flow/);
  assert.match(copy.summary, /hồ sơ Chrome được lưu lâu dài/);
  assert.match(copy.detail, /file tạm/);
  assert.match(copy.detail, /database hay object storage/);
  assert.match(copy.detail, /browser storage\/cache/);
  assert.match(copy.detail, /dự án\/lịch sử Google Flow/);
  assert.match(copy.detail, /không cam kết zero-retention/);
  assert.doesNotMatch(copy.detail, /Vertex AI/);
  assert.doesNotMatch(copy.summary, /không lưu ảnh trong hệ thống của mình/);
});
