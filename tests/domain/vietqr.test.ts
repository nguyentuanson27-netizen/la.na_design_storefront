import assert from "node:assert/strict";
import test from "node:test";

import { buildQrImage, buildVietQrPayload, crc16 } from "../../src/commerce/vietqr.ts";

type Field = { id: string; value: string };

function parseFields(text: string): Field[] {
  const fields: Field[] = [];
  let at = 0;
  while (at < text.length) {
    const length = Number(text.slice(at + 2, at + 4));
    fields.push({ id: text.slice(at, at + 2), value: text.slice(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  assert.equal(at, text.length, "fields must consume the whole payload");
  return fields;
}

const input = { bankBin: "970422", accountNumber: "123456789", amountVnd: 1_230_000, content: "123456789" };

test("crc16 matches the CCITT-FALSE check value", () => {
  assert.equal(crc16("123456789"), "29B1");
});

test("the payload is a well-formed VietQR transfer to the account, with a valid checksum", () => {
  const payload = buildVietQrPayload(input);
  assert.ok(payload);

  assert.equal(payload.slice(-8, -4), "6304");
  assert.equal(payload.slice(-4), crc16(payload.slice(0, -4)));

  const top = parseFields(payload);
  const byId = (id: string) => top.find((entry) => entry.id === id)?.value;
  assert.deepEqual(top.map((entry) => entry.id), ["00", "01", "38", "53", "54", "58", "62", "63"]);
  assert.equal(byId("01"), "12");
  assert.equal(byId("53"), "704");
  assert.equal(byId("54"), "1230000");
  assert.equal(byId("58"), "VN");
  assert.deepEqual(parseFields(byId("62") ?? ""), [{ id: "08", value: "123456789" }]);

  const merchant = parseFields(byId("38") ?? "");
  assert.deepEqual(merchant.map((entry) => entry.id), ["00", "01", "02"]);
  assert.equal(merchant[0]?.value, "A000000727");
  assert.equal(merchant[2]?.value, "QRIBFTTA");
  assert.deepEqual(parseFields(merchant[1]?.value ?? ""), [
    { id: "00", value: "970422" },
    { id: "01", value: "123456789" },
  ]);
});

test("no payload is made when any part cannot be stated safely", () => {
  assert.equal(buildVietQrPayload({ ...input, bankBin: "MB" }), null);
  assert.equal(buildVietQrPayload({ ...input, bankBin: "97042" }), null);
  assert.equal(buildVietQrPayload({ ...input, accountNumber: "12 34" }), null);
  assert.equal(buildVietQrPayload({ ...input, amountVnd: 0 }), null);
  assert.equal(buildVietQrPayload({ ...input, amountVnd: 1.5 }), null);
  assert.equal(buildVietQrPayload({ ...input, content: "" }), null);
  assert.equal(buildVietQrPayload({ ...input, content: "x".repeat(26) }), null);
  assert.equal(buildVietQrPayload({ ...input, content: "Đơn hàng" }), null);
  assert.ok(buildVietQrPayload({ ...input, content: "LA-ABCD2345" }));
});

test("the QR image is a square path of dark modules", () => {
  const payload = buildVietQrPayload(input);
  assert.ok(payload);
  const image = buildQrImage(payload);
  assert.ok(image.size >= 21);
  assert.match(image.path, /^(M\d+ \d+h1v1h-1z)+$/);
});
