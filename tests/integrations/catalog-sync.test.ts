import assert from "node:assert/strict";
import test from "node:test";

import { syncPancakeCatalog } from "../../src/commerce/catalog-sync.ts";

type Query = Readonly<Record<string, string | number | boolean>>;

function catalogPage(pageNumber: number, totalPages: number) {
  return {
    success: true,
    page_number: pageNumber,
    page_size: 100,
    total_entries: 0,
    total_pages: totalPages,
    data: [],
  };
}

function emptyCompositePage() {
  return {
    success: true,
    page_number: 1,
    page_size: 100,
    total_entries: 0,
    total_pages: 0,
    data: [],
  };
}

test("catalog sync completes catalog and composite traversals before handing one snapshot to persistence", async () => {
  const events: string[] = [];
  const client = {
    async getJson(_endpoint: string, query: Query) {
      const role = query.included_composite;
      if (role === "parent" || role === "children") {
        events.push(`composite:${role}`);
        return emptyCompositePage();
      }
      const page = Number(query.page_number);
      events.push(`fetch:${page}`);
      return catalogPage(page, 2);
    },
  };
  const repository = {
    async syncSnapshot(input: {
      shopId: number;
      variations: readonly unknown[];
      compositeSnapshot: {
        parentVariationIds: readonly string[];
        componentVariationIds: readonly string[];
        parentIdentities: readonly unknown[];
        componentIdentities: readonly unknown[];
        edges: readonly unknown[];
      };
      syncedAt: Date;
    }) {
      events.push("persist");
      assert.equal(input.shopId, 123);
      assert.deepEqual(input.variations, []);
      assert.deepEqual(input.compositeSnapshot, {
        parentVariationIds: [],
        componentVariationIds: [],
        parentIdentities: [],
        componentIdentities: [],
        edges: [],
      });
      assert.deepEqual(input.syncedAt, new Date("2026-08-11T00:00:00.000Z"));
      return { products: 0, variations: 0 };
    },
  };

  const result = await syncPancakeCatalog({
    client,
    repository,
    shopId: 123,
    clock: () => new Date("2026-08-11T00:00:00.000Z"),
  });

  assert.deepEqual(events, [
    "fetch:1",
    "fetch:2",
    "composite:parent",
    "composite:children",
    "persist",
  ]);
  assert.deepEqual(result, { products: 0, variations: 0 });
});

test("catalog sync never mutates the mirror when any catalog page fails validation", async () => {
  let persisted = false;
  const client = {
    async getJson(_endpoint: string, query: Query) {
      const page = Number(query.page_number);
      return page === 1
        ? catalogPage(1, 2)
        : { ...catalogPage(2, 2), success: false };
    },
  };
  const repository = {
    async syncSnapshot() {
      persisted = true;
      return { products: 0, variations: 0 };
    },
  };

  await assert.rejects(
    () =>
      syncPancakeCatalog({
        client,
        repository,
        shopId: 123,
        clock: () => new Date("2026-08-11T00:00:00.000Z"),
      }),
    /unsuccessful/i,
  );
  assert.equal(persisted, false);
});

test("catalog sync never mutates the mirror when the composite traversal fails validation", async () => {
  let persisted = false;
  const client = {
    async getJson(_endpoint: string, query: Query) {
      if (query.included_composite === "parent") {
        return { ...emptyCompositePage(), total_entries: 0, data: [{}] };
      }
      if (query.included_composite === "children") return emptyCompositePage();
      return catalogPage(1, 0);
    },
  };
  const repository = {
    async syncSnapshot() {
      persisted = true;
      return { products: 0, variations: 0 };
    },
  };

  await assert.rejects(
    () =>
      syncPancakeCatalog({
        client,
        repository,
        shopId: 123,
        clock: () => new Date("2026-08-11T00:00:00.000Z"),
      }),
    /composite pagination/i,
  );
  assert.equal(persisted, false);
});

test("G5 the stock-observation marker is sampled before the first Pancake read", async () => {
  // ADR 0014 §4.2. This ordering is the whole contract: a committed capacity reservation is retired
  // only once a stock observation that *began* after the commit has landed. A marker sampled after
  // the response came back would claim freshness a pre-commit snapshot does not have, retire the
  // hold early, and leave the units counted by neither side.
  //
  // Asserting the ordering rather than the value is deliberate — a value assertion would still pass
  // if the sampling moved below the fetch.
  const events: string[] = [];
  const observedFrom = new Date("2026-09-17T08:00:00.000Z");

  const client = {
    async getJson(_endpoint: string, query: Query) {
      const role = query.included_composite;
      if (role === "parent" || role === "children") {
        events.push(`fetch:composite:${role}`);
        return emptyCompositePage();
      }
      events.push("fetch:catalog");
      return catalogPage(1, 1);
    },
  };

  let stamped: Date | null = null;
  const repository = {
    async syncSnapshot(input: { syncedAt: Date }) {
      events.push("persist");
      stamped = input.syncedAt;
      return { products: 0, variations: 0 };
    },
  };

  await syncPancakeCatalog({
    client,
    repository,
    shopId: 123,
    clock: () => {
      events.push("clock");
      return observedFrom;
    },
  });

  assert.equal(events[0], "clock", "the marker must be sampled before anything is fetched");
  assert.equal(events.at(-1), "persist");
  assert.ok(
    events.indexOf("clock") < events.indexOf("fetch:catalog"),
    "the marker must precede the first catalog read",
  );
  assert.deepEqual(stamped, observedFrom, "the sampled instant is what reaches the mirror");
});

test("G5 a caller cannot supply a marker taken after the reads returned", async () => {
  // The previous shape accepted `syncedAt: Date`, so a caller could compute it after the fetch and
  // the signature would accept it. A clock removes that: the caller chooses the time source, never
  // the moment it is sampled. This test documents the property by showing that even a clock which
  // tries to observe the fetch sees nothing yet.
  let fetchesAtSampleTime = -1;
  let fetches = 0;

  const client = {
    async getJson(_endpoint: string, query: Query) {
      fetches += 1;
      const role = query.included_composite;
      if (role === "parent" || role === "children") return emptyCompositePage();
      return catalogPage(1, 1);
    },
  };

  await syncPancakeCatalog({
    client,
    repository: {
      async syncSnapshot() {
        return { products: 0, variations: 0 };
      },
    },
    shopId: 123,
    clock: () => {
      fetchesAtSampleTime = fetches;
      return new Date("2026-09-17T08:00:00.000Z");
    },
  });

  assert.equal(fetchesAtSampleTime, 0, "no Pancake request may have been issued when the clock is read");
  assert.ok(fetches > 0, "the fixture must actually fetch, or the assertion above is vacuous");
});
