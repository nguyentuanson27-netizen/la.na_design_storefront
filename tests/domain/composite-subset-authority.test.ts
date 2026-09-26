import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCompositeSubSetShape,
  isThreePieceComboShape,
  resolveCompositeSubSetAuthority,
  resolveCompositeSubSetAuthorityFromRows,
  type CompositeSubSetComboCandidate,
  type CompositeSubSetPiece,
} from "../../src/commerce/composite-subset-authority.ts";

const ao: CompositeSubSetPiece = { componentVariantId: "ao-m", roleSku: "AO-555-M" };
const cv: CompositeSubSetPiece = { componentVariantId: "cv-m", roleSku: "CV-555-M" };
const quan: CompositeSubSetPiece = { componentVariantId: "quan-m", roleSku: "QUAN-555-M" };

function combo(
  variantId: string,
  components: readonly CompositeSubSetPiece[],
  isSellable = true,
): CompositeSubSetComboCandidate {
  return { variantId, isSellable, components };
}

test("subset shape is exactly {ÁO, CV} or {ÁO, QUẦN}", () => {
  assert.equal(classifyCompositeSubSetShape([ao, cv]), "SET VÁY");
  assert.equal(classifyCompositeSubSetShape([cv, ao]), "SET VÁY");
  assert.equal(classifyCompositeSubSetShape([ao, quan]), "SET QUẦN");

  // A one-piece composite containing only CV used to pass the role test as SET VÁY.
  assert.equal(classifyCompositeSubSetShape([cv]), null);
  assert.equal(classifyCompositeSubSetShape([cv, quan]), null);
  assert.equal(classifyCompositeSubSetShape([ao, cv, quan]), null);
  assert.equal(
    classifyCompositeSubSetShape([ao, { componentVariantId: "ao-l", roleSku: "AO-555-L" }]),
    null,
  );
  assert.equal(classifyCompositeSubSetShape([ao, ao]), null);
  assert.equal(
    classifyCompositeSubSetShape([ao, { componentVariantId: "x", roleSku: null }]),
    null,
  );
  assert.equal(
    classifyCompositeSubSetShape([ao, { componentVariantId: "x", roleSku: "AO-QUAN-1" }]),
    null,
  );
});

test("combo shape is exactly one ÁO, one CV and one QUẦN", () => {
  assert.equal(isThreePieceComboShape([ao, cv, quan]), true);
  assert.equal(isThreePieceComboShape([ao, cv]), false);
  assert.equal(
    isThreePieceComboShape([ao, cv, { componentVariantId: "cv-l", roleSku: "CV-555-L" }]),
    false,
  );
  assert.equal(
    isThreePieceComboShape([ao, cv, quan, { componentVariantId: "x", roleSku: "PHU-KIEN" }]),
    false,
  );
});

test("a subset is authorized only by one sellable 3-piece combo containing every component", () => {
  assert.equal(
    resolveCompositeSubSetAuthority({
      subSetVariantId: "set-vay-m",
      subSetComponents: [ao, cv],
      candidateCombos: [combo("combo-m", [ao, cv, quan])],
    }),
    "SET VÁY",
  );
  assert.equal(
    resolveCompositeSubSetAuthority({
      subSetVariantId: "set-quan-m",
      subSetComponents: [ao, quan],
      candidateCombos: [combo("combo-m", [ao, cv, quan])],
    }),
    "SET QUẦN",
  );

  assert.equal(
    resolveCompositeSubSetAuthority({
      subSetVariantId: "set-vay-m",
      subSetComponents: [ao, cv],
      candidateCombos: [combo("combo-m", [ao, cv, quan], false)],
    }),
    null,
    "an inactive combo authorizes nothing",
  );
  assert.equal(
    resolveCompositeSubSetAuthority({
      subSetVariantId: "set-vay-m",
      subSetComponents: [ao, cv],
      candidateCombos: [combo("set-vay-m", [ao, cv, quan])],
    }),
    null,
    "a subset never authorizes itself",
  );
  assert.equal(
    resolveCompositeSubSetAuthority({
      subSetVariantId: "set-vay-m",
      subSetComponents: [ao, cv],
      candidateCombos: [combo("other-set", [ao, cv])],
    }),
    null,
    "a 2-piece parent is not a combo",
  );
});

test("components spread across different combos do not authorize a subset", () => {
  const cvB: CompositeSubSetPiece = { componentVariantId: "cv-b-m", roleSku: "CV-747-M" };
  const aoB: CompositeSubSetPiece = { componentVariantId: "ao-b-m", roleSku: "AO-747-M" };
  const quanB: CompositeSubSetPiece = { componentVariantId: "quan-b-m", roleSku: "QUAN-747-M" };

  assert.equal(
    resolveCompositeSubSetAuthority({
      subSetVariantId: "rogue-m",
      subSetComponents: [ao, cvB],
      candidateCombos: [combo("combo-a-m", [ao, cv, quan]), combo("combo-b-m", [aoB, cvB, quanB])],
    }),
    null,
  );
});

test("row adapter gathers candidate combos from every component's parents", () => {
  const parentRow = (
    id: string,
    pieces: readonly CompositeSubSetPiece[],
    active = true,
  ) => ({
    parentVariant: {
      id,
      isPresent: true,
      isActive: active,
      product: { isPresent: true, isActive: true },
      compositeComponents: pieces.map((piece) => ({
        componentVariantId: piece.componentVariantId,
        componentVariant: { sku: piece.roleSku, pancakeDisplayId: null },
      })),
    },
  });
  const row = (piece: CompositeSubSetPiece, parents: ReturnType<typeof parentRow>[]) => ({
    componentVariantId: piece.componentVariantId,
    componentVariant: { sku: piece.roleSku, pancakeDisplayId: null, compositeParents: parents },
  });

  const comboParent = parentRow("combo-m", [ao, cv, quan]);
  const selfParent = parentRow("set-vay-m", [ao, cv]);
  assert.equal(
    resolveCompositeSubSetAuthorityFromRows({
      subSetVariantId: "set-vay-m",
      components: [row(ao, [comboParent, selfParent]), row(cv, [comboParent, selfParent])],
    }),
    "SET VÁY",
  );

  // Áo is in active COMBO A, Váy is in active COMBO B: each component has *some* active parent,
  // which the previous predicate accepted, but no single combo contains both.
  const cvB: CompositeSubSetPiece = { componentVariantId: "cv-b-m", roleSku: "CV-747-M" };
  const comboA = parentRow("combo-a-m", [ao, cv, quan]);
  const comboB = parentRow("combo-b-m", [
    { componentVariantId: "ao-b-m", roleSku: "AO-747-M" },
    cvB,
    { componentVariantId: "quan-b-m", roleSku: "QUAN-747-M" },
  ]);
  assert.equal(
    resolveCompositeSubSetAuthorityFromRows({
      subSetVariantId: "rogue-m",
      components: [row(ao, [comboA]), row(cvB, [comboB])],
    }),
    null,
  );

  assert.equal(
    resolveCompositeSubSetAuthorityFromRows({
      subSetVariantId: "set-vay-m",
      components: [
        row(ao, [parentRow("combo-m", [ao, cv, quan], false)]),
        row(cv, [parentRow("combo-m", [ao, cv, quan], false)]),
      ],
    }),
    null,
  );
});
