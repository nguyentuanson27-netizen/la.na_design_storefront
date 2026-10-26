import assert from "node:assert/strict";
import test from "node:test";

import jsQR from "jsqr";

import { buildQrImage, buildVietQrPayload, crc16, type QrImage } from "../../src/commerce/vietqr.ts";

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

/** Rasterize the SVG path the page draws (black modules, white quiet zone) into RGBA pixels. */
function rasterize(image: QrImage, scale = 6, quiet = 4) {
  const dark = new Set([...image.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((match) => `${match[1]},${match[2]}`));
  const side = (image.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      if (dark.has(`${Math.floor(x / scale) - quiet},${Math.floor(y / scale) - quiet}`)) {
        const at = (y * side + x) * 4;
        data[at] = data[at + 1] = data[at + 2] = 0;
      }
    }
  }
  return { data, side };
}

test("an independent decoder reads the rendered QR back to the beneficiary, amount and content", () => {
  for (const facts of [
    input,
    { bankBin: "970422", accountNumber: "118619999", amountVnd: 530_000, content: "LA-ABCD2345" },
    { bankBin: "970422", accountNumber: "1234567890123", amountVnd: 99_999_000, content: "ORDER 42" },
  ]) {
    const payload = buildVietQrPayload(facts);
    assert.ok(payload);
    const { data, side } = rasterize(buildQrImage(payload));
    const decoded = jsQR(data, side, side);
    assert.ok(decoded, "the rendered image must be readable as a QR code");
    assert.equal(decoded.data, payload);

    const byId = (fields: Field[], id: string) => fields.find((entry) => entry.id === id)?.value ?? "";
    const top = parseFields(decoded.data);
    const beneficiary = parseFields(byId(parseFields(byId(top, "38")), "01"));
    assert.equal(byId(beneficiary, "00"), facts.bankBin);
    assert.equal(byId(beneficiary, "01"), facts.accountNumber);
    assert.equal(byId(top, "54"), String(facts.amountVnd));
    assert.equal(byId(parseFields(byId(top, "62")), "08"), facts.content);
  }
});
