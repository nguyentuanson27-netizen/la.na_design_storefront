-- Standardize product names for aoDai4Ta (4-panel) and aoDai6Ta (6-panel) categories:
-- - Strips existing "Áo dài" / "Áo Dài" / "set Áo dài" and any existing "4 tà" / "6 tà" prefixes.
-- - Strips any trailing merchant SKU codes (e.g. SD5002) if duplicated in name.
-- - Formats as "Áo dài 4 tà <Name>" or "Áo dài 6 tà <Name>".
-- - Idempotent and safe: preserves existing product slugs and product codes.

UPDATE "ProductMirror" p
SET name = 'Áo dài 4 tà ' || TRIM(regexp_replace(
    regexp_replace(p.name, '\s+[A-Za-z]+\d+[A-Za-z0-9]*$', ''),
    '^(?:(?:set\s+)?[áÁ]o\s+[dD]ài(?:\s+4\s*tà)?|4\s*tà)\s*', '', 'i'
))
FROM "ProductCategoryMembership" m
WHERE p.id = m."productId"
  AND m."categoryKey" = 'aoDai4Ta'
  AND p.name NOT LIKE 'Áo dài 4 tà %';

UPDATE "ProductMirror" p
SET name = 'Áo dài 6 tà ' || TRIM(regexp_replace(
    regexp_replace(p.name, '\s+[A-Za-z]+\d+[A-Za-z0-9]*$', ''),
    '^(?:(?:set\s+)?[áÁ]o\s+[dD]ài(?:\s+6\s*tà)?|6\s*tà)\s*', '', 'i'
))
FROM "ProductCategoryMembership" m
WHERE p.id = m."productId"
  AND m."categoryKey" = 'aoDai6Ta'
  AND p.name NOT LIKE 'Áo dài 6 tà %';
