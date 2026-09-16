# W13A — first-party factual content inventory

Owning source: `docs/audits/seo-geo-audit.md` findings **W13A** / **W13**, planning step **P5**.
Master-plan unit: **U6**. Consumer: **U33 / W13**.

Status: **CURRENT — B1–B4 and B6 are RESOLVED in the owner-approved facts source; U33 is fully implemented (U33a About/Contact, U33b Returns/Shipping, U33c Size Guide).** The only
evergreen surfaces still blocked on an owner decision are the §15 policy pages — general terms,
pricing, privacy, complaint handling, rights and obligations — which have **no approved facts at
all**.

**The per-page inventory further down is the U6-time snapshot.** It records what the repository
owned *when this audit was written*, before any owner gate was answered. It is kept as historical
evidence and must not be read as current status: every `BLOCKED` verdict in it has since been
superseded by the row for that page in the current-status table immediately below. Nothing in the
original inventory was inferred from UI copy, naming conventions or code structure.

U6 built no pages. It recorded what existed, what was close but not authoritative, and what was
missing.

## Current status — supersedes the U6-time snapshot

| Page / surface | U6-time verdict | Current truth |
|---|---|---|
| About | BLOCKED on B6 | **Built (U33a)** — `/about`, from `PUBLIC_BRAND_POSITIONING` (§7), `PUBLIC_LEGAL_FACTS` (§1) and, for the address, `describePublicAddress()` over `PUBLIC_CONTACT_FACTS` (§2). Founder, founding year, story and values stay unapproved and off the page. |
| Contact | BLOCKED on B2 | **Built (U33a)** — `/contact`, from `PUBLIC_CONTACT_FACTS` (§2). |
| Returns | BLOCKED on B1 | **Built (U33b)** — `/returns`, from `PUBLIC_RETURNS_POLICY` (§4). |
| Shipping / Payment | BLOCKED on B4 | **Built (U33b)** — `/shipping`, from `PUBLIC_DELIVERY_FACTS` (§5), `buildPublicBrandFacts`, and the server-owned `readGuestShippingPolicy` for price. |
| Size Guide | BLOCKED on B3 | **Built (U33c)** — `/size-guide`, from `PUBLIC_SIZE_GUIDE` (§6). |
| `Organization` structured data | BLOCKED on B2 | **Enriched (U32b)** — address, contact point and social profile are emitted from `PUBLIC_CONTACT_FACTS`, and the footer renders the same facts, so the markup corresponds to visible content. |
| §15 policy surfaces — general terms, pricing, privacy, complaint handling, rights and obligations | not inventoried | **Still blocked — no approved facts exist.** They stay unbuilt and unlinked rather than authored. |

An agent picking up **U33c** should work from this table and from
`docs/specs/la-clothing-owner-approved-facts-and-decisions.md`, **not** from the U6-time Size Guide
section below, which predates B3 and would stop the unit incorrectly.

## Classification

| Class | Meaning |
|---|---|
| **A — has source of truth** | A single server-owned source already produces the fact and it is already published to buyers. Safe for U33 to reuse. |
| **B — UI copy without authority** | The claim appears in a page or component, but no reviewed source owns it. Reusable only as *evidence for the owner to confirm*, never quoted as policy. |
| **C — missing** | The fact does not exist anywhere in the repository. |
| **D — owner approval required** | A business, legal or contactability decision. A coding agent must not author it regardless of what code or copy suggests. |

## The authoritative sources

**At U6 there was exactly one:** `src/content/public-brand-facts.ts` → `buildPublicBrandFacts(policy)`
was the only reviewed first-party fact source. It is rendered by the site footer and the homepage,
and its exact shape is pinned by `tests/domain/public-brand-content.test.ts`. That shape is
deliberately unchanged — U32b and U33 added constants beside it rather than fields inside it, because
changing it would change what the footer and homepage render.

**Current authority set.** The same module now holds several reviewed constants, one per approved
fact group, each with a single consumer contract:

| Authority | Owns | Landed in |
|---|---|---|
| `buildPublicBrandFacts(policy)` | brand name/summary, payment method, no-account checkout, server re-verification, order tracking, and shipping derived from the server-owned policy | U6 (pre-existing) |
| `PUBLIC_CONTACT_FACTS` | §2 contact channels, address, support hours | U32b |
| `PUBLIC_BRAND_POSITIONING` | §7 positioning sentence | U33a |
| `PUBLIC_LEGAL_FACTS` | §1 legal entity name + confirmed MST, approved for a minimal About by B6/§7. **Not the address** — that stays with `PUBLIC_CONTACT_FACTS`, and `/about` renders it through `describePublicAddress()` | U33a |
| `PUBLIC_RETURNS_POLICY` | §4 returns/exchange/refund clauses, §3 refund channel | U33b |
| `PUBLIC_DELIVERY_FACTS` | §5 coverage, carriers, estimates, tracking and verification notes | U33b |
| `PUBLIC_SIZE_GUIDE` | §6 size charts A and B, units (cm), circumference semantics, ±3 cm tolerance, height/weight guidance | U33c |

The **shipping price stays outside all of them**, with the server-owned `readGuestShippingPolicy`:
B4 keeps it as the pricing authority, and a fee copied into a content constant would let a page
contradict checkout.

The U6-time table below is the `buildPublicBrandFacts` shape, which still holds:

| Fact key | Value source | Class |
|---|---|---|
| `brandName` | Constant `"LA Clothing"` | **A** |
| `brandSummary` | Constant, one sentence | **A** |
| `paymentMethod` | Constant: cash on delivery | **A** |
| `bankTransferUnavailable` | Constant: bank transfer is temporarily unavailable on the website (added by A5, master spec §14) | **A** |
| `checkoutAccount` | Constant: no account required | **A** |
| `shipping` | Derived from the server-owned `GuestShippingPolicy` (`LA_SHIPPING_FEE_VND`, `LA_FREE_SHIPPING_SUBTOTAL_VND`, `LA_FREE_SHIPPING_MIN_QUANTITY`) | **A** |
| `orderTracking` | Constant describing the `/track-order` capability that exists | **A** |
| `serverVerification` | Constant describing behaviour the checkout actually implements | **A** |

Everything an evergreen page needs beyond this list was B, C or D **as of when this inventory was
written**. Every class-D block it names has since been answered by the owner, and all but the Size
Guide has been implemented — see the current-status table above and the update sections below.

### Update: the approved B2 contact facts (U32b)

The owner resolved **B2**, and U32b landed those facts as a second frozen constant in the same
module: `PUBLIC_CONTACT_FACTS` in `src/content/public-brand-facts.ts`.

| Fact key | Value source | Class |
|---|---|---|
| `telephone` | Owner-approved §2 hotline/Zalo number, as the owner wrote it | **A** |
| `telephoneInternational` | The same number with the country code from **O2** (Việt Nam, `+84`); no subscriber digit differs, and a test pins it against the reviewed `normalizeVietnamesePhone` | **A** |
| `email` | Owner-approved §2 support email | **A** |
| `fanpageUrl` | Owner-approved §2 Fanpage | **A** |
| `streetAddress`, `addressLocality` | Owner-approved §2 address string | **A** |
| `supportHours` | Owner-approved §2 hours — the seven days, the local open/close times and the stated UTC+7 offset, kept together so a consumer gets the whole statement | **A** |

It is deliberately a separate export rather than a new field on `buildPublicBrandFacts`: that
function's shape is what the footer and homepage render today, and U32b had no mandate to change
either surface. **U33 must read `PUBLIC_CONTACT_FACTS`** for its Contact page rather than
transcribing §2 again — one authority is the whole point, and the site JSON-LD already reads it.

`describePublicAddress` and `describePublicSupportHours` render the reader-facing forms and
`supportHoursSchemaTime` the schema.org one, all from the same parts. The **site footer renders
these facts**, so the Organization markup that carries them corresponds to content a reader can see.

### Update: About and Contact are built (U33a)

The two pages this inventory classified as fully blocked on owner facts now exist, built only from
approved facts:

| Page | Facts it publishes | Source |
|---|---|---|
| `/contact` | Hotline/Zalo, email, address, support hours, Fanpage | `PUBLIC_CONTACT_FACTS` (§2) |
| `/about` | Brand positioning sentence; legal entity, MST | `PUBLIC_BRAND_POSITIONING` (§7), `PUBLIC_LEGAL_FACTS` (§1, published under B6/§7) |
| `/about` | Address | `describePublicAddress()` over `PUBLIC_CONTACT_FACTS` (§2) — one address authority, shared with `/contact`, the footer and `Organization` |

Neither page transcribes a fact a second time — they render the same constants the footer renders
and the `Organization` structured data marks up. What each page **omits** is asserted, not just
intended: browser tests fail if an origin story, founding year, founder, mission or values reaches
About, or if a contact form or a response-time promise reaches Contact.

**U33b** then built Returns and Shipping/Payment the same way:

| Page | Facts it publishes | Source |
|---|---|---|
| `/returns` | 15-day window, the full condition and supported-case lists, exchange fee, shop-fault shipping, refund window | `PUBLIC_RETURNS_POLICY` (§4) |
| `/shipping` | Coverage, carriers, delivery estimates, estimate caveat, no default carrier tracking, verification-call wording | `PUBLIC_DELIVERY_FACTS` (§5) |
| `/shipping` | Payment method, no-account fact, server re-verification | `buildPublicBrandFacts` — the builder that already owned them, reused rather than duplicated |
| `/shipping`, `/returns` | Refund channel (§3) | `PUBLIC_RETURNS_POLICY.refundChannelNote` — it belongs with the refund policy, not with payment |

Two authorities stay apart there on purpose: the **shipping price** remains `readGuestShippingPolicy`,
which B4 keeps as the pricing authority because production may override it, so a fee is never copied
into the content module — a domain test asserts no price key leaked in. Delivery windows are printed
as estimates because §5 says they are not an SLA, and a test fails on commitment wording.

**U33c** then built the Size Guide:

| Page | Facts it publishes | Source |
|---|---|---|
| `/size-guide` | Chart A, Chart B, cm unit, circumference semantics, ±3 cm tolerance, reference height/weight | `PUBLIC_SIZE_GUIDE` (§6) |

The page renders directly from `PUBLIC_SIZE_GUIDE`. No size calculator or recommendation engine is added, and height/weight values are explicitly published as guidance rather than fit guarantees.

With U33c complete, all five named evergreen pages are built. The remaining §15 policy surfaces — general terms, pricing,
privacy, complaint handling, rights and obligations — have **no approved facts at all** and stay
unbuilt and unlinked rather than authored.

The registered entity name and tax code are **no longer owner-blocked** — B6 approves publishing the
legal entity and the confirmed MST — but they are **outside the B2 contact contract** U32b
implements, so U32b did not publish them; **U33a's About page publishes them**. Founder and founding
year do remain unapproved under B6. Everything else in this inventory still stands.

## Per-page inventory — the U6-time snapshot (historical)

Everything from here to the end of this section is the state **as of U6**, retained so a later
reader can see what was actually missing before the owner answered. Each page's `BLOCKED` line is
the verdict *at that time*; the current-status table above is what holds today.

### About — U6-time

| Fact needed | Current state | Class |
|---|---|---|
| Brand name and one-line positioning | `brandName`, `brandSummary` | **A** |
| Footer strapline "Modern menswear for everyday movement." | Hardcoded in `src/components/layout/site-footer.tsx`, not in the fact source | **B** |
| Homepage and lookbook editorial copy | `src/app/page.tsx`, `src/app/lookbook/page.tsx` and website-owned collection copy | **B** — editorial voice, not verified brand history |
| Founding story, year, values, people | Nowhere | **C** |
| `legalEntity` — registered business name | Nowhere | **C / D** |
| `taxCode` — business registration or tax identifier | Nowhere | **C / D** |

`BLOCKED — OWNER FACT/APPROVAL REQUIRED` *(U6-time verdict)*: founding facts, registered entity
name, and whether the legal identifier should be public at all.

**Superseded:** B6 approved the registered entity, address and MST, and `/about` publishes them
(U33a). Founder, founding year, story and values were *not* approved and remain unpublished.

### Returns — U6-time

| Fact needed | Current state | Class |
|---|---|---|
| `returnPolicy` — whether returns are accepted, and on what conditions | Nowhere | **C / D** |
| `returnWindowDays` — the window in days | Nowhere | **C / D** |
| `exchangePolicy` — size or colour exchanges | Nowhere | **C / D** |
| `refundMethod` — how a COD order is refunded | Nowhere | **C / D** |
| Who pays return shipping | Nowhere | **C / D** |
| Non-returnable categories, if any | Nowhere | **C / D** |

`BLOCKED — OWNER FACT/APPROVAL REQUIRED` *(U6-time verdict)*: the entire returns policy. Nothing in
the repository implied one, and a returns page is exactly the kind of content a coding agent must not
invent — it is a commitment to customers and a consumer-law surface.

**Superseded:** B1 is RESOLVED and `/returns` is built (U33b) from `PUBLIC_RETURNS_POLICY` (§4).
The policy was supplied by the owner, not derived.

### Shipping / Payment — U6-time

| Fact needed | Current state | Class |
|---|---|---|
| Payment method (COD) | `paymentMethod` | **A** |
| Bank transfer temporarily unavailable | `bankTransferUnavailable` | **A** |
| No account required to order | `checkoutAccount` | **A** |
| Shipping fee, free-shipping threshold and minimum quantity | `shipping`, from the server-owned policy | **A** |
| Phone confirmation before delivery | Stated at checkout and on the success page (`src/components/commerce/guest-checkout-form.tsx`, `src/app/checkout/success/page.tsx`) but not in the fact source | **B** |
| Server re-verification of price, stock and address at order time | `serverVerification` | **A** |
| `deliveryEstimate` — how long delivery takes | Nowhere | **C / D** |
| Delivery coverage, or areas not served | Nowhere. Address entry uses Pancake province/district/commune data, which is a geography reference, **not** a statement of where LA Clothing delivers | **C / D** |
| Carrier, and whether orders are trackable with the carrier | Nowhere. `/track-order` exposes the local COD order state only | **C / D** |
| Other payment methods (bank transfer, card, wallet) | Not implemented; checkout is COD only | **C / D** |

This was the only page with a substantial A-class base. It still could not ship complete: a
shipping page without a delivery estimate or coverage statement is the part buyers look for.

`BLOCKED — OWNER FACT/APPROVAL REQUIRED` *(U6-time verdict)*: delivery estimate, coverage, carrier,
and confirmation that the phone-confirmation step is a policy rather than current practice.

**Superseded:** B4 is RESOLVED and `/shipping` is built (U33b). Coverage, carriers, estimates and
the "no default carrier tracking" fact come from `PUBLIC_DELIVERY_FACTS` (§5); phone verification is
published as optional because that is what B4 says. The **shipping price stays with the server-owned
`readGuestShippingPolicy`** — B4 keeps it as the pricing authority, so no fee was copied into the
content module.

### Size Guide — U6-time

| Fact needed | Current state | Class |
|---|---|---|
| Per-product size notes | `ProductContent.sizeGuide`, free text, editor-authored, rendered on the PDP | **B** — per product, editorial, and frequently absent |
| Size vocabulary and ordering | `src/commerce/clothing-size.ts` sorts known size labels | **A**, but it is a sort order, not a measurement fact |
| `sizeChart` — site-wide measurements per size | Nowhere | **C / D** |
| Measuring instructions | Nowhere | **C / D** |
| Fit guidance (regular, relaxed, oversized) and what each means | Product names hint at fit; no defined vocabulary | **C / D** |
| Units and tolerance | Nowhere | **C / D** |

`BLOCKED — OWNER FACT/APPROVAL REQUIRED` *(U6-time verdict)*: the size chart itself. Deriving
centimetres from product names or existing per-product free text would be inventing measurements,
which is worse than having no page: a wrong chart drives returns the returns policy did not then
cover.

**Superseded — read this before starting U33c:** B3 is RESOLVED. The owner supplied two size charts
in centimetres, with circumference semantics and a ±3 cm tolerance; height and weight stay guidance
and never a fit guarantee. **The Size Guide is no longer owner-blocked** — it is unbuilt
implementation work (U33c). The original prohibition still binds in one respect: no measurement, fit
vocabulary or tolerance beyond the approved charts may be derived.

### Contact — U6-time

| Fact needed | Current state | Class |
|---|---|---|
| `contactPhone` | Nowhere. No phone number appears anywhere in the repository | **C / D** |
| `contactEmail` | Nowhere | **C / D** |
| `storeAddress` — physical or registered address | Nowhere | **C / D** |
| `businessHours` — when the brand responds | Nowhere | **C / D** |
| Social or messaging channels | Nowhere in first-party content | **C / D** |
| Order-specific support route | `/track-order` exists and is described by `orderTracking` | **A**, but it is self-service status lookup, not a contact channel |

`BLOCKED — OWNER FACT/APPROVAL REQUIRED` *(U6-time verdict)*: every contact channel. The storefront
then gave a buyer no way to reach the brand other than waiting for the confirmation call, and
inventing a channel would send customers somewhere nobody is listening.

**Superseded:** B2 is RESOLVED. `PUBLIC_CONTACT_FACTS` owns the approved channels, `/contact` is
built (U33a), and the footer and `Organization` markup render the same constants.

## Consequence for structured data — resolved by U32b

*U6-time:* `buildSiteStructuredData` emitted `Organization` with only `name` and `url`. W6 / U32
wanted to enrich it with verified first-party facts — address, contact point, social profiles —
every one of which was class C/D above, so U32's enrichment was blocked by the same owner decision
as U33, not by anything technical.

**Current:** B2 resolved that decision and **U32b is implemented.** `Organization` now carries
`address`, `contactPoint` (with the country-coded telephone, email and support hours) and `sameAs`,
all read from `PUBLIC_CONTACT_FACTS`. There is exactly one `Organization` node, and the site footer
renders the same facts, so the markup corresponds to content a reader can see.

Two different reasons keep other properties off that node, and they must not be conflated:

| Omitted | Why |
|---|---|
| `legalName`, `taxID` | **Approved but out of contract.** B6 *does* approve publishing the legal entity and the confirmed MST — this is not an owner block, and `/about` publishes them. They are outside the **B2** contact contract U32b implements, so U32b did not map them onto `Organization`. |
| `logo`, `availableLanguage`, `addressCountry`, `postalCode` | **No approved fact.** Nothing owner-approved supplies them, and inferring them from the market or the site would be inventing. |
| `founder`, `foundingDate` | **Owner-unapproved.** B6 explicitly leaves founder and founding year unapproved. |

## Registered decision gates

These were recorded as **B1–B4 and B6** in the "Owner decision gates" register in
`tasks/growth-commerce-master-todo.md`, each with its owner, what it blocks and where the blocked
unit must stop. **All five now read resolved in that register** — B1–B4 as `RESOLVED` and B6 as
`RESOLVED FOR MINIMAL ABOUT`. That register is the live one; the table below is the U6-time
statement of what each gate was holding up:

| Gate | Covers | Blocks |
|---|---|---|
| **B1** | Returns policy | U33 Returns page |
| **B2** | Contact channels | U33 Contact page; U32 `Organization` enrichment only |
| **B3** | Size chart | U33 Size Guide page |
| **B4** | Shipping delivery terms | U33 Shipping/Payment page |
| **B6** | About/brand/legal facts — founding story/year/values/people, registered entity name, and whether the tax identifier should be public | U33 (About page) |

Owner in every case: repository owner / brand authority. Until a gate is answered, the blocked unit
stops and reports; every other unit continues. No page is built from an inferred policy, and no
missing fact is reconstructed from UI copy, checkout wording or naming conventions.

**All five gates have since been answered** (B6 for a minimal About only). The rule they encode did
not lapse with them: it still binds the §15 surfaces, which have no approved facts and therefore stay
unbuilt.

## What the owner needed to supply — answered

This was the U6-time ask. It has been answered in
`docs/specs/la-clothing-owner-approved-facts-and-decisions.md`, which is now the authority for every
item below.

For each of About, Returns, Shipping delivery terms, Size Guide and Contact:

1. the factual content itself, in Vietnamese, as the brand wants it published;
2. confirmation of who owns it and when it was last reviewed;
3. whether it is stable enough to live in `buildPublicBrandFacts` as a reviewed constant, or belongs
   in editable website-owned content.

U33 then builds the pages from that single approved source rather than duplicating copy between the
footer, the pages and structured data.

**Where that stands:** the facts were supplied, and U33a, U33b and U32b built About, Contact,
Returns, Shipping/Payment and the `Organization` markup from them; **U33c (Size Guide) is the
remaining slice, and its facts already exist.** The closing rule still applies to what has no
approved source: the §15 policy surfaces get no page, and no thin page is published to chase GEO
keywords.
