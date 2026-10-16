import assert from "node:assert/strict";
import test from "node:test";
import { giftMutationOutcome } from "../../src/components/headless/cart-gift-mutation-model.ts";
test("a lost/ambiguous write must read back, never suggest blindly retrying the write", () => {
  assert.equal(giftMutationOutcome(null), "readback");
  assert.equal(giftMutationOutcome({ok:false, reason:"LOOKUP_FAILED"}), "readback");
  assert.equal(giftMutationOutcome({ok:false, reason:"SELECTION_INVALID"}), "rejected");
  assert.equal(giftMutationOutcome({ok:true}), "saved");
});
