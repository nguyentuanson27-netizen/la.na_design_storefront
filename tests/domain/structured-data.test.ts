import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_CONTACT_FACTS,
  supportHoursSchemaTime,
} from "../../src/content/public-brand-facts.ts";
import {
  buildProductStructuredData,
  buildSiteStructuredData,
  serializeJsonLd,
} from "../../src/seo/structured-data.ts";

const product = {
  slug: "ao-oxford-relaxed",
  name: "Áo Oxford Relaxed",
  editorialDescription: "Áo Oxford Relaxed với nội dung biên tập đã được xuất bản.",
  media: {
    gallery: [
      {
        url: "https://content.pancake.vn/1/2/3/4/ao-oxford.jpg",
        alt: "Áo Oxford Relaxed",
      },
      {
        url: "https://content.pancake.vn/1/2/3/4/ao-oxford-back.jpg",
        alt: "Áo Oxford Relaxed - Ảnh 2",
      },
    ],
  },
};

const onePriceOptions = [
  {
    price: 590_000,
    purchasable: true,
    unavailableReason: null,
  },
  {
    price: 590_000,
    purchasable: false,
    unavailableReason: "OUT_OF_STOCK" as const,
  },
];

const oneVariant = {
  url: "https://shop.example.com/shop/ao-oxford-relaxed?variant=pv-a",
  color: null,
  size: "M",
  price: 590_000,
  availability: "InStock" as const,
  imageUrl: null,
};

const twoIdentifiedVariants = [
  { ...oneVariant, mpn: "A132-M" },
  {
    ...oneVariant,
    url: "https://shop.example.com/shop/ao-oxford-relaxed?variant=pv-b",
    mpn: "A132-L",
    size: "L",
  },
];

test("P14 builds factual Product, Offer, and BreadcrumbList from visible server-authoritative facts", () => {
  const structured = buildProductStructuredData({
    origin: "https://shop.example.com",
    product,
    variantOptions: onePriceOptions,
  });

  assert.deepEqual(structured, {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        "@id": "https://shop.example.com/shop/ao-oxford-relaxed#product",
        name: "Áo Oxford Relaxed",
        url: "https://shop.example.com/shop/ao-oxford-relaxed",
        description: product.editorialDescription,
        image: product.media.gallery.map((item) => item.url),
        brand: {
          "@id": "https://shop.example.com/#organization",
        },
        offers: {
          "@type": "Offer",
          url: "https://shop.example.com/shop/ao-oxford-relaxed",
          priceCurrency: "VND",
          price: 590_000,
          availability: "https://schema.org/InStock",
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Trang chủ",
            item: "https://shop.example.com/",
          },
          {
            "@type": "ListItem",
            position: 2,
            name: "Shop",
            item: "https://shop.example.com/shop",
          },
          {
            "@type": "ListItem",
            position: 3,
            name: "Áo Oxford Relaxed",
          },
        ],
      },
    ],
  });
});

test("P14 emits a truthful OutOfStock Offer only when price is fully resolved and stock is the only blocker", () => {
  const structured = buildProductStructuredData({
    origin: "https://shop.example.com",
    product,
    variantOptions: [
      { price: 590_000, purchasable: false, unavailableReason: "OUT_OF_STOCK" },
      { price: 590_000, purchasable: false, unavailableReason: "OUT_OF_STOCK" },
    ],
  });

  const productNode = structured["@graph"][0];
  assert.equal(productNode["@type"], "Product");
  assert.deepEqual(productNode.offers, {
    "@type": "Offer",
    url: "https://shop.example.com/shop/ao-oxford-relaxed",
    priceCurrency: "VND",
    price: 590_000,
    availability: "https://schema.org/OutOfStock",
  });
});

test("P14 omits Offer instead of misrepresenting variant price ranges or unresolved commerce state", () => {
  const priceRange = buildProductStructuredData({
    origin: "https://shop.example.com",
    product,
    variantOptions: [
      { price: 590_000, purchasable: true, unavailableReason: null },
      { price: 690_000, purchasable: true, unavailableReason: null },
    ],
  });
  const unresolved = buildProductStructuredData({
    origin: "https://shop.example.com",
    product,
    variantOptions: [
      { price: 590_000, purchasable: false, unavailableReason: "AMBIGUOUS_OPTION" },
      { price: 590_000, purchasable: false, unavailableReason: "AMBIGUOUS_OPTION" },
    ],
  });

  assert.equal("offers" in priceRange["@graph"][0], false);
  assert.equal("offers" in unresolved["@graph"][0], false);
});

test("P14/U27 refuses ProductGroup when structural or variant-identifier gates are not proven", () => {
  for (const productGroup of [
    undefined,
    null,
    { productGroupID: "pancake-product-1", variesBy: [], variants: twoIdentifiedVariants },
    { productGroupID: "pancake-product-1", variesBy: ["SIZE" as const], variants: [] },
    { productGroupID: "", variesBy: ["SIZE" as const], variants: twoIdentifiedVariants },
    { productGroupID: " pancake-product-1 ", variesBy: ["SIZE" as const], variants: twoIdentifiedVariants },
    { productGroupID: "p".repeat(129), variesBy: ["SIZE" as const], variants: twoIdentifiedVariants },
    // Looks structurally valid, but no reviewed variant identifier exists.
    {
      productGroupID: "pancake-product-1",
      variesBy: ["SIZE" as const],
      variants: [
        oneVariant,
        { ...oneVariant, url: "https://shop.example.com/shop/ao-oxford-relaxed?variant=pv-b", size: "L" },
      ],
    },
    // A manufacturer MPN must distinguish variants rather than being duplicated across the family.
    {
      productGroupID: "pancake-product-1",
      variesBy: ["SIZE" as const],
      variants: twoIdentifiedVariants.map((variant) => ({ ...variant, mpn: "DUP" })),
    },
  ]) {
    const serialized = JSON.stringify(
      buildProductStructuredData({
        origin: "https://shop.example.com",
        product,
        variantOptions: onePriceOptions,
        productGroup,
      }),
    );

    for (const forbidden of ["ProductGroup", "hasVariant", "productGroupID", "variesBy"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  }
});

test("U27 serializer publishes ProductGroup only with unique reviewed MPNs", () => {
  const structured = buildProductStructuredData({
    origin: "https://shop.example.com",
    product,
    variantOptions: onePriceOptions,
    productGroup: {
      productGroupID: "pancake-product-1",
      variesBy: ["SIZE"],
      variants: twoIdentifiedVariants,
    },
  });

  const group = structured["@graph"][0];
  assert.equal(group["@type"], "ProductGroup");
  assert.deepEqual(group.hasVariant.map((variant) => variant.mpn), ["A132-M", "A132-L"]);
  assert.equal("offers" in group, false);
});

test("P14 omits invented product and merchant-policy facts", () => {
  const structured = buildProductStructuredData({
    origin: "https://shop.example.com",
    product: {
      ...product,
      editorialDescription: null,
      media: { gallery: [] },
    },
    variantOptions: onePriceOptions,
  });
  const productNode = structured["@graph"][0];

  assert.equal("description" in productNode, false);
  assert.equal("image" in productNode, false);
  for (const forbidden of [
    "aggregateRating",
    "review",
    "gtin",
    "gtin13",
    "gtin14",
    "material",
    "shippingDetails",
    "hasMerchantReturnPolicy",
  ]) {
    assert.equal(forbidden in productNode, false, forbidden);
  }
});

test("P14 builds factual Organization and WebSite entities from the validated storefront origin", () => {
  assert.deepEqual(buildSiteStructuredData({ origin: "https://shop.example.com" }), {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://shop.example.com/#organization",
        name: "La.na Design",
        url: "https://shop.example.com/",
        // U32b: the approved B2 facts. Written out literally here — this case exists to show the
        // whole emitted document at a glance; the U32b guard below is what ties each value back to
        // `PUBLIC_CONTACT_FACTS` so the two cannot drift.
        address: {
          "@type": "PostalAddress",
          streetAddress: "212 Nguyễn Trãi, Đại Mỗ",
          addressLocality: "Hà Nội",
        },
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          // U32b: the country-code form Google asks for; same approved number as the footer shows.
          telephone: "+84923159666",
          email: "la.nadesignsince2022@gmail.com",
          hoursAvailable: {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: [
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
              "Sunday",
            ],
            opens: "08:00:00+07:00",
            closes: "22:00:00+07:00",
          },
        },
        sameAs: ["https://www.facebook.com/la.nadesign.vn"],
      },
      {
        "@type": "WebSite",
        "@id": "https://shop.example.com/#website",
        name: "La.na Design",
        url: "https://shop.example.com/",
        publisher: {
          "@id": "https://shop.example.com/#organization",
        },
      },
    ],
  });
});

test("P14 JSON-LD serialization neutralizes closing-script injection", () => {
  const serialized = serializeJsonLd({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "</script><script>alert('p14')</script>",
  });

  assert.equal(serialized.includes("<"), false);
  assert.equal(serialized.includes("</script>"), false);
  assert.match(serialized, /\\u003c\/script>/);
});


/**
 * U32a / W5. `sku` is the website-owned `VariantMirror.sku` - Schema.org's merchant-specific
 * identifier. It is deliberately a different fact from `mpn`, which ADR 0008 fixes as the
 * owner-confirmed manufacturer identifier mirrored from Pancake `display_id`. Publishing one must
 * never publish the other, and neither may stand in for the other.
 */
test("U32a publishes the website-owned SKU on the variant node it belongs to", () => {
  const structured = buildProductStructuredData({
    origin: "https://shop.example.com",
    product,
    variantOptions: onePriceOptions,
    productGroup: {
      productGroupID: "pancake-product-1",
      variesBy: ["SIZE"],
      variants: [
        { ...twoIdentifiedVariants[0], sku: "LA-OXF-M" },
        { ...twoIdentifiedVariants[1], sku: "LA-OXF-L" },
      ],
    },
  });

  const group = structured["@graph"][0];
  assert.equal(group["@type"], "ProductGroup");
  assert.deepEqual(
    group.hasVariant.map((variant) => variant.sku),
    ["LA-OXF-M", "LA-OXF-L"],
    "each variant node carries its own SKU, never a sibling's",
  );
  assert.deepEqual(
    group.hasVariant.map((variant) => variant.mpn),
    ["A132-M", "A132-L"],
    "ADR 0008 MPNs are untouched by the SKU that sits beside them",
  );
});

test("U32a omits SKU rather than publishing a junk value", () => {
  const unpublishable = [null, undefined, "", "   ", " LA-OXF-M", "LA-OXF-M ", "L".repeat(129)];
  for (const sku of unpublishable) {
    const structured = buildProductStructuredData({
      origin: "https://shop.example.com",
      product,
      variantOptions: onePriceOptions,
      productGroup: {
        productGroupID: "pancake-product-1",
        variesBy: ["SIZE"],
        variants: [
          { ...twoIdentifiedVariants[0], sku },
          { ...twoIdentifiedVariants[1], sku: "LA-OXF-L" },
        ],
      },
    });

    const group = structured["@graph"][0];
    assert.equal(group["@type"], "ProductGroup");
    assert.equal(
      "sku" in group.hasVariant[0],
      false,
      `an unpublishable SKU must be absent, not empty or placeholder: ${JSON.stringify(sku)}`,
    );
    assert.equal(
      group.hasVariant[1].sku,
      "LA-OXF-L",
      "one variant's unpublishable SKU must not suppress a sibling's good one",
    );
  }
});

/**
 * Fail-closed on GTIN. `VariantMirror.pancakeBarcode` is a mirrored external value whose upstream
 * type, format, check digit and lifecycle are unproven, so nothing may map it to a GTIN property.
 * This asserts the absence structurally rather than trusting that no one wired it up.
 */
test("U32a publishes no GTIN property anywhere, whatever the catalog holds", () => {
  const structured = buildProductStructuredData({
    origin: "https://shop.example.com",
    product,
    variantOptions: onePriceOptions,
    productGroup: {
      productGroupID: "pancake-product-1",
      variesBy: ["SIZE"],
      variants: [
        // A 13-digit EAN shape. Looking like a GTIN is not being one.
        { ...twoIdentifiedVariants[0], sku: "4006381333931" },
        { ...twoIdentifiedVariants[1], sku: "LA-OXF-L" },
      ],
    },
  });

  const serialized = serializeJsonLd(structured);
  for (const property of ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "isbn"]) {
    assert.equal(
      new RegExp(`"${property}"\\s*:`).test(serialized),
      false,
      `${property} must never be published from an unproven barcode or a SKU that resembles one`,
    );
  }
  const group = structured["@graph"][0];
  assert.equal(group["@type"], "ProductGroup");
  assert.equal(
    group.hasVariant[0].sku,
    "4006381333931",
    "a GTIN-shaped value still publishes as the SKU it actually is",
  );
});


/**
 * U32b. B2 is resolved, so the Organization entity now publishes the approved contact facts — and
 * only those. The guard did not go away when the block lifted; it moved. It pins the exact key set,
 * checks every published value against the one fact authority rather than a literal repeated here,
 * and keeps asserting the absence of everything no owner source states.
 */
test("U32b publishes the approved B2 contact facts on the Organization entity", () => {
  const site = buildSiteStructuredData({ origin: "https://shop.example.com" });
  const organization = site["@graph"][0];

  assert.equal(organization["@type"], "Organization");
  assert.deepEqual(
    Object.keys(organization).sort(),
    ["@id", "@type", "address", "contactPoint", "name", "sameAs", "url"],
    "the Organization entity must carry exactly its identity plus the approved B2 facts",
  );

  // Values are compared to the fact source, not to copies: a literal here would let the two drift.
  assert.deepEqual(organization.address, {
    "@type": "PostalAddress",
    streetAddress: PUBLIC_CONTACT_FACTS.streetAddress,
    addressLocality: PUBLIC_CONTACT_FACTS.addressLocality,
  });
  assert.deepEqual(organization.contactPoint, {
    "@type": "ContactPoint",
    contactType: "customer support",
    telephone: PUBLIC_CONTACT_FACTS.telephoneInternational,
    email: PUBLIC_CONTACT_FACTS.email,
    hoursAvailable: {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: PUBLIC_CONTACT_FACTS.supportHours.days,
      opens: supportHoursSchemaTime(PUBLIC_CONTACT_FACTS.supportHours.opens),
      closes: supportHoursSchemaTime(PUBLIC_CONTACT_FACTS.supportHours.closes),
    },
  });
  assert.deepEqual(organization.sameAs, [PUBLIC_CONTACT_FACTS.fanpageUrl]);
});

test("U32b publishes no Organization fact the owner has not approved", () => {
  const serialized = serializeJsonLd(
    buildSiteStructuredData({ origin: "https://shop.example.com" }),
  );

  for (const blocked of [
    // B2 approved contact facts only. It approved no logo asset, so none is published — the social
    // card is a share image, not a brand mark, and reusing it as `logo` would misstate what it is.
    "logo",
    // `legalName`/`taxID` are not owner-blocked: B6 approves publishing the legal entity and the
    // confirmed MST. They are outside the B2 contact contract U32b implements and belong to the
    // About/legal surface U33 builds. `founder`/`foundingDate` do stay unapproved under B6.
    "founder",
    "foundingDate",
    "vatID",
    "taxID",
    "legalName",
    // The owner approved an address string, not a structured postal address. `addressCountry` and
    // `postalCode` are not in it, and deriving them from the city name would be an inference about
    // a legal address rather than a transcription of one.
    "addressCountry",
    "postalCode",
    // Support answering in a given language is a business capability, not something the site's own
    // served locale establishes.
    "availableLanguage",
  ]) {
    assert.equal(
      new RegExp(`"${blocked}"\\s*:`).test(serialized),
      false,
      `${blocked} is not an owner-approved Organization fact and must not be published`,
    );
  }
});

/**
 * The whole point of W6 is entity consistency: one Organization, referenced by everything else.
 * Enriching it must not spawn a second copy of the brand carrying the same facts again.
 */
test("U32b keeps one Organization entity that every other node references by id", () => {
  const site = buildSiteStructuredData({ origin: "https://shop.example.com" });
  const organizationId = site["@graph"][0]["@id"];

  assert.equal(site["@graph"][1].publisher["@id"], organizationId);
  assert.equal(
    serializeJsonLd(site).match(/"@type":"Organization"/g)?.length,
    1,
    "exactly one Organization node may exist",
  );
});
