import assert from "node:assert/strict";
import test from "node:test";

import { parseGuestCheckoutInput } from "../../src/commerce/guest-checkout-input.ts";

test("guest checkout accepts only the approved COD contact and two-level address fields", () => {
  const result = parseGuestCheckoutInput({
    name: "  Nguyễn Văn A  ",
    phone: "  0901 234 567  ",
    provinceRef: "  84_VN101  ",
    // A district sent by an old page is ignored: the address is province → ward/commune.
    districtRef: "  district-001  ",
    communeRef: "  84_VN10105  ",
    detail: "  12 Đường A, căn hộ 3B  ",
    note: "  Gọi trước khi giao  ",
    price: 1,
    stock: 999,
    discount: 100,
    shippingFee: 0,
    pancakeOrderId: "browser-controlled",
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      name: "Nguyễn Văn A",
      phone: "0901234567",
      provinceRef: "84_VN101",
      districtRef: null,
      communeRef: "84_VN10105",
      detail: "12 Đường A, căn hộ 3B",
      note: "Gọi trước khi giao",
      paymentMethod: "COD",
      attribution: null,
    },
  });
});

test("guest checkout normalizes a blank optional note to null", () => {
  assert.deepEqual(
    parseGuestCheckoutInput({
      name: "Nguyễn Văn A",
      phone: "+84 901 234 567",
      provinceRef: "84_VN101",
      communeRef: "84_VN10105",
      detail: "12 Đường A",
      note: "   ",
    }),
    {
      ok: true,
      value: {
        name: "Nguyễn Văn A",
        phone: "0901234567",
        provinceRef: "84_VN101",
        districtRef: null,
        communeRef: "84_VN10105",
        detail: "12 Đường A",
        note: null,
        paymentMethod: "COD",
        attribution: null,
      },
    },
  );
});

test("guest checkout fails closed for malformed, missing, blank, or unbounded fields", () => {
  const valid = {
    name: "Nguyễn Văn A",
    phone: "0901234567",
    provinceRef: "84_VN101",
    communeRef: "84_VN10105",
    detail: "12 Đường A",
  };

  for (const input of [
    null,
    [],
    {},
    { ...valid, name: "" },
    { ...valid, phone: 901234567 },
    { ...valid, phone: "   " },
    { ...valid, provinceRef: "   " },
    { ...valid, communeRef: undefined },
    { ...valid, detail: "" },
    { ...valid, detail: "x".repeat(2_049) },
    { ...valid, note: "x".repeat(2_049) },
  ]) {
    assert.deepEqual(parseGuestCheckoutInput(input), { ok: false, reason: "INVALID_INPUT" });
  }
});

test("guest checkout names a wrong phone number separately so the buyer is told what to fix", () => {
  const valid = {
    name: "Nguyễn Văn A",
    provinceRef: "84_VN101",
    communeRef: "84_VN10105",
    detail: "12 Đường A",
  };
  for (const phone of ["12345", "0123456789", "09123456789", "0912-abc-678", "+1 202 555 0100"]) {
    assert.deepEqual(parseGuestCheckoutInput({ ...valid, phone }), {
      ok: false,
      reason: "INVALID_PHONE",
    }, phone);
  }
});

test("guest checkout keeps an attribution line only if it is exactly what the cookie reader writes", () => {
  const valid = {
    name: "Nguyễn Văn A",
    phone: "0901234567",
    provinceRef: "84_VN101",
    communeRef: "84_VN10105",
    detail: "12 Đường A",
    note: "Gọi trước khi giao",
  };

  const accepted = parseGuestCheckoutInput({ ...valid, attribution: "[UTM] source=facebook;medium=paid" });
  assert.equal(accepted.ok && accepted.value.attribution, "[UTM] source=facebook;medium=paid");
  // Kept apart from the shopper's own note, which is what the length limit is measured on.
  assert.equal(accepted.ok && accepted.value.note, "Gọi trước khi giao");

  for (const attribution of ["source=facebook", "[ORDER:LA-1]", "[UTM] source=a\nb", "[UTM] ", 7, {}]) {
    const result = parseGuestCheckoutInput({ ...valid, attribution });
    assert.equal(result.ok && result.value.attribution, null, String(attribution));
  }
});

test("guest checkout accepts only the two known payment methods", () => {
  const valid = {
    name: "Nguyễn Văn A",
    phone: "0901234567",
    provinceRef: "84_VN101",
    communeRef: "84_VN10105",
    detail: "12 Đường A",
  };
  const method = (paymentMethod: unknown) => {
    const result = parseGuestCheckoutInput({ ...valid, paymentMethod });
    return result.ok ? result.value.paymentMethod : result.reason;
  };

  assert.equal(method(undefined), "COD");
  assert.equal(method(""), "COD");
  assert.equal(method("COD"), "COD");
  assert.equal(method("BANK_TRANSFER"), "BANK_TRANSFER");
  assert.equal(method("cod"), "INVALID_INPUT");
  assert.equal(method("MOMO"), "INVALID_INPUT");
  assert.equal(method(1), "INVALID_INPUT");
});
