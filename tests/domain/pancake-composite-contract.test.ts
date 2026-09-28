import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePancakeCompositeSnapshot,
  quarantineCompositesOutsideCatalog,
  type PancakeCompositeSnapshot,
} from "../../src/integrations/pancake/composite-contract.ts";

function parentRow({
  id = "set-m",
  productId = "set-product",
  edges = [
    componentEdge({ id: "edge-shirt", parentId: "set-m", componentId: "shirt-m", componentProductId: "shirt-product" }),
    componentEdge({ id: "edge-pants", parentId: "set-m", componentId: "pants-m", componentProductId: "pants-product" }),
  ],
}: {
  id?: string;
  productId?: string;
  edges?: unknown[];
} = {}) {
  return {
    id,
    product_id: productId,
    is_composite: true,
    composite_products: edges,
  };
}

function childRow({
  id,
  productId,
}: {
  id: string;
  productId: string;
}) {
  return {
    id,
    product_id: productId,
    is_composite: false,
    composite_products: [],
  };
}

function componentEdge({
  id,
  parentId,
  componentId,
  componentProductId,
  quantity = 1,
  shopId = 47,
}: {
  id: string;
  parentId: string;
  componentId: string;
  componentProductId: string;
  quantity?: number;
  shopId?: number;
}) {
  return {
    id,
    variation_id: parentId,
    component_id: componentId,
    quantity,
    shop_id: shopId,
    measure_info: null,
    component: {
      id: componentId,
      product_id: componentProductId,
      is_composite: false,
    },
  };
}

function validChildren() {
  return [
    childRow({ id: "shirt-m", productId: "shirt-product" }),
    childRow({ id: "pants-m", productId: "pants-product" }),
  ];
}

test("Pancake composite contract parses direct parent-to-component variation edges", () => {
  const snapshot = parsePancakeCompositeSnapshot({
    shopId: 47,
    parentEntries: [parentRow()],
    childEntries: validChildren(),
  });

  assert.deepEqual(snapshot, {
    parentVariationIds: ["set-m"],
    componentVariationIds: ["pants-m", "shirt-m"],
    parentIdentities: [{ variationId: "set-m", productId: "set-product" }],
    componentIdentities: [
      { variationId: "pants-m", productId: "pants-product" },
      { variationId: "shirt-m", productId: "shirt-product" },
    ],
    edges: [
      { parentVariationId: "set-m", componentVariationId: "pants-m", quantity: 1 },
      { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 },
    ],
    quarantinedParentVariationIds: [],
  } satisfies PancakeCompositeSnapshot);
});

test("Pancake composite contract rejects identity, shop, nesting, quantity, duplicate, and component-product contradictions", () => {
  const invalidCases: Array<{ parents: unknown[]; children?: unknown[] }> = [
    {
      parents: [
        parentRow({
          edges: [
            componentEdge({
              id: "edge-1",
              parentId: "different-parent",
              componentId: "shirt-m",
              componentProductId: "shirt-product",
            }),
          ],
        }),
      ],
    },
    {
      parents: [
        parentRow({
          edges: [
            componentEdge({
              id: "edge-1",
              parentId: "set-m",
              componentId: "shirt-m",
              componentProductId: "shirt-product",
              shopId: 48,
            }),
          ],
        }),
      ],
    },
    {
      parents: [
        parentRow({
          edges: [
            {
              ...componentEdge({
                id: "edge-1",
                parentId: "set-m",
                componentId: "shirt-m",
                componentProductId: "shirt-product",
              }),
              component: {
                id: "shirt-m",
                product_id: "shirt-product",
                is_composite: true,
              },
            },
          ],
        }),
      ],
    },
    {
      parents: [
        parentRow({
          edges: [
            componentEdge({
              id: "edge-1",
              parentId: "set-m",
              componentId: "shirt-m",
              componentProductId: "shirt-product",
              quantity: 0.5,
            }),
          ],
        }),
      ],
    },
    {
      parents: [
        parentRow({
          edges: [
            componentEdge({
              id: "edge-1",
              parentId: "set-m",
              componentId: "shirt-m",
              componentProductId: "shirt-product",
            }),
            componentEdge({
              id: "edge-2",
              parentId: "set-m",
              componentId: "shirt-m",
              componentProductId: "shirt-product",
            }),
          ],
        }),
      ],
    },
    {
      // The component resolves, but to a different product than its own row: a contradiction.
      parents: [
        parentRow({
          edges: [
            componentEdge({
              id: "edge-1",
              parentId: "set-m",
              componentId: "shirt-m",
              componentProductId: "other-product",
            }),
          ],
        }),
      ],
    },
  ];

  for (const invalid of invalidCases) {
    assert.throws(
      () =>
        parsePancakeCompositeSnapshot({
          shopId: 47,
          parentEntries: invalid.parents,
          childEntries: invalid.children ?? validChildren(),
        }),
      /composite contract/i,
    );
  }
});

test("Pancake composite contract rejects overlapping parent/child roles and nested child edges", () => {
  assert.throws(
    () =>
      parsePancakeCompositeSnapshot({
        shopId: 47,
        parentEntries: [parentRow()],
        childEntries: [
          {
            id: "set-m",
            product_id: "set-product",
            is_composite: false,
            composite_products: [],
          },
          ...validChildren(),
        ],
      }),
    /composite contract/i,
  );

  assert.throws(
    () =>
      parsePancakeCompositeSnapshot({
        shopId: 47,
        parentEntries: [parentRow()],
        childEntries: [
          {
            ...childRow({ id: "shirt-m", productId: "shirt-product" }),
            composite_products: [{}],
          },
          childRow({ id: "pants-m", productId: "pants-product" }),
        ],
      }),
    /composite contract/i,
  );
});

// A second, complete combo that must survive whatever happens to the combo under test.
function dressCombo() {
  return parentRow({
    id: "dress-set-m",
    productId: "dress-set-product",
    edges: [
      componentEdge({
        id: "edge-dress",
        parentId: "dress-set-m",
        componentId: "dress-m",
        componentProductId: "dress-product",
      }),
    ],
  });
}

test("real Pancake rows reporting is_composite: null for ordinary products parse as non-composite", () => {
  const snapshot = parsePancakeCompositeSnapshot({
    shopId: 47,
    parentEntries: [
      parentRow({
        edges: [
          {
            ...componentEdge({
              id: "edge-shirt",
              parentId: "set-m",
              componentId: "shirt-m",
              componentProductId: "shirt-product",
            }),
            component: { id: "shirt-m", product_id: "shirt-product", is_composite: null },
          },
        ],
      }),
    ],
    childEntries: [{ ...childRow({ id: "shirt-m", productId: "shirt-product" }), is_composite: null }],
  });

  assert.deepEqual(snapshot.edges, [
    { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 },
  ]);
  assert.deepEqual(snapshot.quarantinedParentVariationIds, []);
});

test("a combo with no components is quarantined instead of failing the snapshot", () => {
  const snapshot = parsePancakeCompositeSnapshot({
    shopId: 47,
    parentEntries: [parentRow({ edges: [] }), dressCombo()],
    childEntries: [childRow({ id: "dress-m", productId: "dress-product" })],
  });

  assert.deepEqual(snapshot.parentVariationIds, ["dress-set-m"]);
  assert.deepEqual(snapshot.edges, [
    { parentVariationId: "dress-set-m", componentVariationId: "dress-m", quantity: 1 },
  ]);
  assert.deepEqual(snapshot.quarantinedParentVariationIds, ["set-m"]);
});

test("a combo with a missing component is quarantined whole, never kept as a partial graph", () => {
  // set-m's pants component is hidden/deleted: it is not in the children listing at all.
  const snapshot = parsePancakeCompositeSnapshot({
    shopId: 47,
    parentEntries: [parentRow(), dressCombo()],
    childEntries: [
      childRow({ id: "shirt-m", productId: "shirt-product" }),
      childRow({ id: "dress-m", productId: "dress-product" }),
    ],
  });

  assert.deepEqual(snapshot.parentVariationIds, ["dress-set-m"]);
  // The shirt edge is dropped with its combo, and shirt-m is no longer a listed component.
  assert.deepEqual(snapshot.componentVariationIds, ["dress-m"]);
  assert.deepEqual(snapshot.edges, [
    { parentVariationId: "dress-set-m", componentVariationId: "dress-m", quantity: 1 },
  ]);
  assert.deepEqual(snapshot.quarantinedParentVariationIds, ["set-m"]);
});

test("a combo whose parent or component is absent from the flat catalog is quarantined whole", () => {
  const complete = parsePancakeCompositeSnapshot({
    shopId: 47,
    parentEntries: [parentRow(), dressCombo()],
    childEntries: [...validChildren(), childRow({ id: "dress-m", productId: "dress-product" })],
  });

  // pants-m is hidden from the catalog; set-m must go, dress-set-m must stay intact.
  const resolved = quarantineCompositesOutsideCatalog(complete, (id) => id !== "pants-m");
  assert.deepEqual(resolved.parentVariationIds, ["dress-set-m"]);
  assert.deepEqual(resolved.componentVariationIds, ["dress-m"]);
  assert.deepEqual(resolved.edges, [
    { parentVariationId: "dress-set-m", componentVariationId: "dress-m", quantity: 1 },
  ]);
  assert.deepEqual(resolved.quarantinedParentVariationIds, ["set-m"]);

  // A catalog that has everything returns the snapshot unchanged.
  assert.equal(quarantineCompositesOutsideCatalog(complete, () => true), complete);
});

test("quarantine never softens the strict checks: a quarantined parent listed as a child still fails", () => {
  assert.throws(
    () =>
      parsePancakeCompositeSnapshot({
        shopId: 47,
        parentEntries: [parentRow({ edges: [] })],
        childEntries: [childRow({ id: "set-m", productId: "set-product" })],
      }),
    /composite contract/i,
  );
  // A duplicate parent row is still a contradiction, even when both are empty.
  assert.throws(
    () =>
      parsePancakeCompositeSnapshot({
        shopId: 47,
        parentEntries: [parentRow({ edges: [] }), parentRow({ edges: [] })],
        childEntries: [],
      }),
    /composite contract/i,
  );
});
