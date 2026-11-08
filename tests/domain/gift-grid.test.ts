import assert from "node:assert/strict";
import test from "node:test";

import { giftGridCells } from "../../src/components/brand/gift-grid.ts";

const cells = (count: number, open: number | null) => Array.from({ length: count }, (_, index) => ({ tile: `t${index + 1}`, detail: index === open ? `d${index + 1}` : null }));

test("PR 254 / P2: the open gift's details follow the last tile of its row; no tile moves, so reading and Tab order match the grid", () => {
  assert.deepEqual(giftGridCells(cells(4, null)), ["t1", "t2", "t3", "t4"]);
  // Four gifts, the third open: row one stays 1-2-3, the details come next, then 4 (never 1-2-4 over 3).
  assert.deepEqual(giftGridCells(cells(4, 2)), ["t1", "t2", "t3", "d3", "t4"]);
  assert.deepEqual(giftGridCells(cells(4, 0)), ["t1", "t2", "t3", "d1", "t4"]);
  assert.deepEqual(giftGridCells(cells(6, 3)), ["t1", "t2", "t3", "t4", "t5", "t6", "d4"]);
  // A short last row: the details close it.
  assert.deepEqual(giftGridCells(cells(5, 3)), ["t1", "t2", "t3", "t4", "t5", "d4"]);
  assert.deepEqual(giftGridCells(cells(2, 1)), ["t1", "t2", "d2"]);
});
