import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBankTransferInstructions,
  parsePaymentMethod,
  readBankTransferConfig,
  renderTransferContent,
} from "../../src/commerce/bank-transfer.ts";

const account = {
  BANK_TRANSFER_ENABLED: "true",
  BANK_TRANSFER_BANK_NAME: " MBBank ",
  BANK_TRANSFER_ACCOUNT_NUMBER: "123456789",
  BANK_TRANSFER_ACCOUNT_HOLDER: "NGUYEN VAN A",
};

test("bank transfer is off unless explicitly enabled and fully configured", () => {
  assert.equal(readBankTransferConfig({}), null);
  assert.equal(readBankTransferConfig({ ...account, BANK_TRANSFER_ENABLED: undefined }), null);
  assert.equal(readBankTransferConfig({ ...account, BANK_TRANSFER_ENABLED: "1" }), null);
  assert.equal(readBankTransferConfig({ ...account, BANK_TRANSFER_BANK_NAME: " " }), null);
  assert.equal(readBankTransferConfig({ ...account, BANK_TRANSFER_ACCOUNT_NUMBER: undefined }), null);
  assert.equal(readBankTransferConfig({ ...account, BANK_TRANSFER_ACCOUNT_HOLDER: "" }), null);
  assert.equal(readBankTransferConfig({ ...account, BANK_TRANSFER_ACCOUNT_NUMBER: "12 34" }), null);
});

test("a configured account is trimmed and defaults the content to the order id", () => {
  assert.deepEqual(readBankTransferConfig(account), {
    bankName: "MBBank",
    accountNumber: "123456789",
    accountHolder: "NGUYEN VAN A",
    contentTemplate: "{ORDER_ID}",
  });
});

test("payment method parsing defaults to COD and refuses anything unknown", () => {
  assert.equal(parsePaymentMethod(undefined), "COD");
  assert.equal(parsePaymentMethod(null), "COD");
  assert.equal(parsePaymentMethod("BANK_TRANSFER"), "BANK_TRANSFER");
  assert.equal(parsePaymentMethod("bank_transfer"), null);
  assert.equal(parsePaymentMethod({}), null);
});

test("transfer content renders known placeholders and refuses anything it cannot state safely", () => {
  const facts = { orderId: "123456", publicCode: "LA-ABCD2345" };
  assert.equal(renderTransferContent("{ORDER_ID}", facts), "123456");
  assert.equal(renderTransferContent("LANA {ORDER_ID} {PUBLIC_CODE}", facts), "LANA 123456 LA-ABCD2345");
  assert.equal(renderTransferContent("{BILL_PHONE_NUMBER} {ORDER_ID}", facts), null);
  assert.equal(renderTransferContent("   ", facts), null);
  assert.equal(renderTransferContent("x".repeat(51), facts), null);
});

test("instructions are shown only for a bank-transfer order that can be stated in full", () => {
  const config = readBankTransferConfig(account);
  const order = { paymentMethod: "BANK_TRANSFER" as const, publicCode: "LA-ABCD2345", pancakeOrderId: "987", totalVnd: BigInt(530_000) };

  const shown = buildBankTransferInstructions(config, order);
  assert.equal(shown?.accountNumber, "123456789");
  assert.equal(shown?.amountVnd, 530_000);
  assert.equal(shown?.content, "987");
  assert.match(shown?.amountText ?? "", /530\.000/);

  assert.equal(buildBankTransferInstructions(null, order), null);
  assert.equal(buildBankTransferInstructions(config, { ...order, paymentMethod: "COD" }), null);
  assert.equal(buildBankTransferInstructions(config, { ...order, pancakeOrderId: null }), null);
  assert.equal(buildBankTransferInstructions(config, { ...order, totalVnd: null }), null);
  assert.equal(buildBankTransferInstructions(config, { ...order, totalVnd: BigInt(0) }), null);
});
