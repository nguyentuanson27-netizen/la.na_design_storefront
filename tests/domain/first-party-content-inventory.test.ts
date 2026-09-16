import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { buildPublicBrandFacts } from "../../src/content/public-brand-facts.ts";

/**
 * W13A is a historical inventory of which evergreen-page facts the repository owned at that time and
 * which still required an owner decision. The current owner decisions live in the master roadmap and
 * owner-facts source; keep historical evidence distinct from current implementation state.
 */
const INVENTORY = new URL("../../docs/audits/first-party-content-facts-w13a.md", import.meta.url);
const MASTER_TODO = new URL("../../tasks/growth-commerce-master-todo.md", import.meta.url);

const AUTHORITATIVE_FACT_KEYS = [
  "bankTransferUnavailable",
  "brandName",
  "brandSummary",
  "checkoutAccount",
  "orderTracking",
  "paymentMethod",
  "serverVerification",
  "shipping",
] as const;

/**
 * Facts W13A classified as owner-blocked at U6. Later slices resolved and implemented them through
 * focused authorities; this guard keeps `buildPublicBrandFacts` from silently absorbing those
 * unrelated contracts and changing its existing consumers.
 */
const HISTORICALLY_OWNER_BLOCKED_FACT_KEYS = [
  "returnPolicy",
  "returnWindowDays",
  "exchangePolicy",
  "refundMethod",
  "contactPhone",
  "contactEmail",
  "storeAddress",
  "businessHours",
  "sizeChart",
  "deliveryEstimate",
  "legalEntity",
  "taxCode",
] as const;

const policy = {
  feeVnd: 30_000,
  freeShippingSubtotalVnd: 1_000_000,
  freeShippingMinQuantity: 3,
} as const;

test("W13A the authoritative brand-fact source exposes exactly the inventoried runtime facts", () => {
  const facts = buildPublicBrandFacts(policy);

  assert.deepEqual(Object.keys(facts).sort(), [...AUTHORITATIVE_FACT_KEYS]);
});

test("resolved focused authorities do not get folded into the original runtime fact source", () => {
  const facts = buildPublicBrandFacts(policy) as Record<string, unknown>;

  for (const key of HISTORICALLY_OWNER_BLOCKED_FACT_KEYS) {
    assert.equal(
      key in facts,
      false,
      `${key} belongs to a focused post-U6 authority, not buildPublicBrandFacts`,
    );
  }
});

test("W13A historical inventory still documents every fact it owned or classified as blocked", async () => {
  const inventory = await readFile(INVENTORY, "utf8");

  for (const key of [...AUTHORITATIVE_FACT_KEYS, ...HISTORICALLY_OWNER_BLOCKED_FACT_KEYS]) {
    assert.ok(inventory.includes(key), `${key} must remain documented in the historical W13A inventory`);
  }
});

/**
 * The audit is what a later agent reads before starting adjacent evergreen work. Its current-status
 * block must say what exists now, while the U6 snapshot remains intact and explicitly historical.
 */
test("W13A states the current truth and marks the U6-time snapshot as historical", async () => {
  const inventory = await readFile(INVENTORY, "utf8");

  const [status] = inventory.split("## Classification");
  assert.ok(status, "the audit must open with a status block");

  assert.doesNotMatch(
    status,
    /Status: \*\*BLOCKED/,
    "the top-level status must state the current truth, not the U6-time verdict",
  );
  assert.match(status, /Status: \*\*CURRENT — B1–B4 and B6 are RESOLVED/);
  assert.match(status, /U33 is fully implemented/);
  assert.match(status, /A7b publishes all eleven §33 policy topics/);

  // B3 is resolved and implemented; a reader must not stop on its historical owner block.
  assert.match(
    status,
    /\| Size Guide \| BLOCKED on B3 \| \*\*Built \(U33c\)\*\* — `\/size-guide`, from `PUBLIC_SIZE_GUIDE` \(§6\)\./,
  );
  assert.match(status, /\| `Organization` structured data \|[^\n]*\*\*Enriched \(U32b\)\*\*/);

  // A7b resolved the five §33 policy topics. Current truth must never regress to the old blocker.
  assert.doesNotMatch(
    status,
    /§15 policy surfaces[^\n]*\*\*Still blocked — no approved facts exist\.\*\*/,
  );
  assert.match(
    status,
    /\| §15 policy surfaces — general terms, pricing, privacy, complaint handling, rights and obligations \| not inventoried \| \*\*Owner-approved and published \(A7b\)\*\*/,
  );

  // Keeping the evidence is the point; presenting it as current status is the bug.
  assert.match(inventory, /## Per-page inventory — the U6-time snapshot \(historical\)/);
  assert.match(inventory, /## Consequence for structured data — resolved by U32b/);

  const retainedVerdicts = inventory.match(/`BLOCKED — OWNER FACT\/APPROVAL REQUIRED`/g) ?? [];
  const historicalLabels = inventory.match(/\*\(U6-time verdict\)\*/g) ?? [];
  const supersededNotes = inventory.match(/\*\*Superseded/g) ?? [];
  assert.equal(retainedVerdicts.length, 5, "the five U6-time page verdicts are the historical record");
  assert.equal(historicalLabels.length, retainedVerdicts.length);
  assert.equal(supersededNotes.length, retainedVerdicts.length);
});

/**
 * Current authority documentation must name every focused owner so a later change extends the right
 * source instead of duplicating legal, contact, fulfillment or size truth.
 */
test("W13A describes the current authority set and the real reason each Organization property is omitted", async () => {
  const inventory = await readFile(INVENTORY, "utf8");

  assert.doesNotMatch(
    inventory,
    /`buildPublicBrandFacts\(policy\)` is the only reviewed/,
    "the single-source claim is U6-time and must be labelled or rewritten, not stated as current",
  );
  assert.match(inventory, /\*\*At U6 there was exactly one:\*\*/);
  assert.match(inventory, /\*\*Current authority set\.\*\*/);
  for (const authority of [
    "buildPublicBrandFacts(policy)",
    "PUBLIC_CONTACT_FACTS",
    "PUBLIC_BRAND_POSITIONING",
    "PUBLIC_LEGAL_FACTS",
    "PUBLIC_RETURNS_POLICY",
    "PUBLIC_DELIVERY_FACTS",
    "PUBLIC_SIZE_GUIDE",
    "POLICY_CONTENT",
  ]) {
    assert.ok(
      inventory.includes(`| \`${authority}\` |`),
      `${authority} must appear in the current authority set`,
    );
  }

  const policyRow = inventory
    .split("\n")
    .find((line) => line.startsWith("| `POLICY_CONTENT` |"));
  assert.ok(policyRow, "the current authority set must carry a POLICY_CONTENT row");
  assert.match(policyRow, /§33/);
  assert.match(policyRow, /owner-approved/);
  assert.match(policyRow, /A7b/);

  const legalRow = inventory
    .split("\n")
    .find((line) => line.startsWith("| `PUBLIC_LEGAL_FACTS` |"));
  assert.ok(legalRow, "the current authority set must carry a PUBLIC_LEGAL_FACTS row");
  assert.match(legalRow, /§1 legal entity name \+ confirmed MST/);
  assert.match(legalRow, /B6\/§7/);
  assert.doesNotMatch(legalRow, /§11/, "§11 is Google Ads Purchase value, not the legal identity");
  assert.doesNotMatch(
    legalRow,
    /(?<!Not the )address/,
    "the address belongs to PUBLIC_CONTACT_FACTS; PUBLIC_LEGAL_FACTS must not claim it",
  );
  assert.match(legalRow, /\*\*Not the address\*\*[^|]*`PUBLIC_CONTACT_FACTS`/);
  assert.match(inventory, /shipping price stays outside all of them\*\*, with the server-owned\s+`readGuestShippingPolicy`/);

  assert.match(
    inventory,
    /\| `legalName`, `taxID` \| \*\*Approved but out of contract\.\*\*[^\n]*B6 \*does\* approve[^\n]*outside the \*\*B2\*\* contact contract/,
  );
  assert.match(
    inventory,
    /\| `founder`, `foundingDate` \| \*\*Owner-unapproved\.\*\*/,
  );
  assert.doesNotMatch(
    inventory,
    /Facts the owner did\nnot approve — logo, legal name/,
    "legalName must not be listed among facts the owner did not approve",
  );
});

test("current roadmap preserves W13A history while recording the resolved owner decisions", async () => {
  const [inventory, masterTodo] = await Promise.all([
    readFile(INVENTORY, "utf8"),
    readFile(MASTER_TODO, "utf8"),
  ]);

  assert.match(inventory, /\| \*\*B6\*\* \| About(?:\/brand\/legal)? facts .*\| U33 \(About page\) \|/);
  assert.match(inventory, /For each of About, Returns, Shipping delivery terms, Size Guide and Contact:/);

  assert.match(
    masterTodo,
    /\*\*U33\*\*[^\n]+\*\*B1–B4 and B6 are RESOLVED; U33 is fully implemented[^\n]*\.\*\*/,
  );
  assert.match(masterTodo, /\*\*U33\*\*[^\n]+A7b now publishes all eleven §33 policy topics/);
  assert.match(masterTodo, /\*\*U33a\*\*[^\n]+About \+ Contact/);
  assert.match(masterTodo, /- \[x\] \*\*U33b\*\*[^\n]+Returns \+ Shipping\/Payment/);
  assert.match(masterTodo, /\*\*U33b\*\*[^\n]+shipping price is deliberately not in the content module/);
  assert.match(masterTodo, /- \[x\] \*\*U33c\*\*[^\n]+Size Guide/);

  // Keep the old slice boundaries as history, but they must explicitly point at the newer A7b truth.
  assert.match(
    masterTodo,
    /\*\*U33a\*\*[^\n]+At U33a merge time[^\n]+no approved facts yet[^\n]+superseded by A7b/,
  );
  assert.match(
    masterTodo,
    /\*\*U33c\*\*[^\n]+At U33c merge time[^\n]+remaining §15 policy surfaces remained unbuilt[^\n]+superseded by A7b/,
  );
  assert.match(
    masterTodo,
    /\| \*\*B6\*\* \| \*\*RESOLVED FOR MINIMAL ABOUT\*\*[^\n]+\| U33 About owner-unblocked \|/,
  );
  assert.match(
    masterTodo,
    /\*\*U29\*\*[^\n]+\*\*B5 enforcement is IMPLEMENTED at the admin publish path; the W2a database-level enforcement condition and the slug\/path metadata cleanup itself remain OPEN\.\*\*/,
  );
  assert.match(
    masterTodo,
    /\*\*U29\*\*[^\n]+The application owns this invariant, not the database/,
  );
  assert.match(
    masterTodo,
    /\*\*U29\*\*[^\n]+pair-level[^\n]*`\(seoTitle, seoDescription\)`/,
  );
  assert.match(masterTodo, /\*\*U29\*\*[^\n]+Real-catalog verification of slug-free copy is PENDING/);
  assert.match(
    masterTodo,
    /\| \*\*B5\*\* \| \*\*RESOLVED\*\* — pair-level `\(seoTitle, seoDescription\)` uniqueness among published products; drafts may be missing\/duplicate; collision blocks publish \|/,
  );
});
