-- Standardize product names for the aoDai4Ta (4-panel) and aoDai6Ta (6-panel) categories to
-- "Áo dài 4 tà <Name>" / "Áo dài 6 tà <Name>", mirroring normalizeCategoryProductDisplayName().
--
-- - Strips a leading "Áo dài" / "Áo Dài" / "Set áo dài" (optionally already followed by "4 tà"/"6 tà"),
--   or a bare "4 tà"/"6 tà", then prepends the category label.
-- - Strips the product's own trailing productCode when the name still carries it.
-- - A product in both categories gets the 4-panel label, the same precedence as the application code.
-- - Idempotent, and never touches slug or productCode (URLs / SEO stay unchanged).
--
-- Regex backslashes are single because standard_conforming_strings is on: '\s' reaches the regex engine as-is.

UPDATE "ProductMirror" p
SET name = 'Áo dài 4 tà ' || TRIM(regexp_replace(
    CASE
      WHEN p."productCode" IS NOT NULL
        AND length(p.name) > length(p."productCode") + 1
        AND right(p.name, length(p."productCode") + 1) = ' ' || p."productCode"
        THEN left(p.name, length(p.name) - length(p."productCode") - 1)
      ELSE p.name
    END,
    '^(?:(?:set\s+)?[áÁ]o\s+dài(?:\s+[46]\s*tà)?|[46]\s*tà)(?=\s|$)\s*', '', 'i'
))
FROM "ProductCategoryMembership" m
WHERE p.id = m."productId"
  AND m."categoryKey" = 'aoDai4Ta'
  AND p.name NOT LIKE 'Áo dài 4 tà %';

UPDATE "ProductMirror" p
SET name = 'Áo dài 6 tà ' || TRIM(regexp_replace(
    CASE
      WHEN p."productCode" IS NOT NULL
        AND length(p.name) > length(p."productCode") + 1
        AND right(p.name, length(p."productCode") + 1) = ' ' || p."productCode"
        THEN left(p.name, length(p.name) - length(p."productCode") - 1)
      ELSE p.name
    END,
    '^(?:(?:set\s+)?[áÁ]o\s+dài(?:\s+[46]\s*tà)?|[46]\s*tà)(?=\s|$)\s*', '', 'i'
))
FROM "ProductCategoryMembership" m
WHERE p.id = m."productId"
  AND m."categoryKey" = 'aoDai6Ta'
  AND p.name NOT LIKE 'Áo dài 6 tà %'
  AND NOT EXISTS (
    SELECT 1 FROM "ProductCategoryMembership" m4
    WHERE m4."productId" = p.id AND m4."categoryKey" = 'aoDai4Ta'
  );
