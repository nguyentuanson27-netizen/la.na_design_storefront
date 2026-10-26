import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminCancelArgs } from "../../src/commerce/voucher-admin-cancel.ts";

const evidence = "staff cancelled in Pancake UI, ticket 123";

test("the admin-cancel command needs an order and evidence, is a dry run unless --apply, and refuses anything else", () => {
  assert.deepEqual(parseAdminCancelArgs(["--order", "LN-ABC123", "--evidence", evidence]), { order: "LN-ABC123", evidence, apply: false });
  assert.deepEqual(parseAdminCancelArgs(["--evidence", `  ${evidence}  `, "--order", "cmabc123", "--apply"]), { order: "cmabc123", evidence, apply: true });
  for (const bad of [
    [], ["--order", "LN-ABC123"], ["--evidence", evidence],
    ["--order", "LN-ABC123", "--evidence", "short"],
    ["--order", "LN-ABC123", "--evidence", "x".repeat(401)],
    ["--order", "LN ABC", "--evidence", evidence], ["--order", "a;rm -rf", "--evidence", evidence],
    ["--order", "LN-ABC123", "--evidence", "line one\nline two is long enough"],
    ["--order", "LN-ABC123", "--evidence", evidence, "--force"],
    ["--order", "LN-ABC123", "--order", "LN-ABC124", "--evidence", evidence],
    ["--order", "LN-ABC123", "--evidence"],
  ]) assert.equal(parseAdminCancelArgs(bad), null, JSON.stringify(bad));
});
