-- Standardize product names for the aoDai4Ta (4-panel) and aoDai6Ta (6-panel) categories to
-- "Áo dài 4 tà <Name>" / "Áo dài 6 tà <Name>".
--
-- "ProductMirror"."sourceName" keeps the Pancake-derived name (trailing product code already split
-- off), so "name" is always a pure function of ("sourceName", category memberships) and the same
-- result comes out of catalog sync, the admin membership edit and this migration. The temporary
-- functions below are a line-by-line port of normalizeCategoryProductDisplayName() in
-- src/commerce/product-display-name.ts (tests/database/aodai-flap-name-migration.test.ts runs this
-- file against fixtures and compares every row with the TypeScript function). Keep them in step.
--
-- A product in both categories gets the 4-panel label. slug and productCode are never touched.

ALTER TABLE "ProductMirror" ADD COLUMN IF NOT EXISTS "sourceName" TEXT;

-- Lower-case Vietnamese capitals independently of the database locale (a C-locale lower() leaves
-- them alone). One-to-one character translation, so string length is preserved.
CREATE FUNCTION pg_temp.vi_lower(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(lower(t), 'ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬĐÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ', 'àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ')
$$;

-- splitTrailingProductCode(...).name: drop one trailing merchant SKU ("X SV605", "X - SV605",
-- "X (SV605)", "X [SV605]") unless nothing or only garment-type words would be left.
CREATE FUNCTION pg_temp.flap_strip_code(src text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH t AS (
    SELECT regexp_replace(src, '^\s+|\s+$', '', 'g') AS trimmed
  ), s AS (
    SELECT trimmed,
           regexp_replace(
             trimmed,
             '(?:(?:\s+|\s*[-–—|:/]\s*)#?[A-Za-z]+\d+[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*'
               || '|\s*\(\s*#?[A-Za-z]+\d+[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*\s*\)'
               || '|\s*\[\s*#?[A-Za-z]+\d+[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*\s*\])$',
             ''
           ) AS head
    FROM t
  ), n AS (
    SELECT trimmed, regexp_replace(head, '^\s+|\s+$', '', 'g') AS name FROM s
  )
  SELECT CASE
    WHEN name = '' OR name = trimmed THEN trimmed
    WHEN (
      SELECT count(*) > 0 AND bool_and(
        pg_temp.vi_lower(normalize(w, NFC)) = ANY (ARRAY['set', 'bộ', 'đồ', 'váy', 'đầm', 'quần', 'áo', 'chân', 'dài', 'ngắn', 'khoác', 'sơ', 'mi', 'thun', 'len', 'yếm', 'vest', 'blazer', 'croptop', 'jumpsuit', 'phụ', 'kiện', 'túi', 'ví', 'khăn', 'mũ', 'nón', 'kẹp', 'giày', 'guốc', 'nữ', 'và'])
        OR (
          pg_temp.vi_lower(normalize(w, NFC))
            = replace(regexp_replace(normalize(pg_temp.vi_lower(normalize(w, NFC)), NFD), '[\u0300-\u036f]', '', 'g'), 'đ', 'd')
          AND replace(regexp_replace(normalize(pg_temp.vi_lower(normalize(w, NFC)), NFD), '[\u0300-\u036f]', '', 'g'), 'đ', 'd')
            = ANY (ARRAY['ao', 'blazer', 'bo', 'chan', 'croptop', 'dai', 'dam', 'do', 'giay', 'guoc', 'jumpsuit', 'kep', 'khan', 'khoac', 'kien', 'len', 'mi', 'mu', 'ngan', 'non', 'nu', 'phu', 'quan', 'set', 'so', 'thun', 'tui', 'va', 'vay', 'vest', 'vi', 'yem'])
        )
      )
      FROM unnest(regexp_split_to_array(name, '[\s,&+/]+')) AS w
      WHERE w <> ''
    ) THEN trimmed
    ELSE name
  END
  FROM n
$$;

-- normalizeCategoryProductDisplayName(src, [flap category]) for a given flap label.
CREATE FUNCTION pg_temp.flap_display_name(src text, label text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH b AS (
    SELECT pg_temp.flap_strip_code(src) AS base
  ), m AS (
    SELECT base,
           regexp_match(
             pg_temp.vi_lower(base),
             '^(?:(?:set\s+)?áo\s+dài(?:\s+[46]\s*tà)?|[46]\s*tà)(?=\s|$)\s*'
           ) AS prefix
    FROM b
  ), r AS (
    SELECT regexp_replace(
             CASE WHEN prefix IS NULL THEN base ELSE substr(base, char_length(prefix[1]) + 1) END,
             '^\s+|\s+$', '', 'g'
           ) AS model
    FROM m
  )
  SELECT CASE WHEN model = '' THEN label ELSE label || ' ' || model END FROM r
$$;

-- Existing flap products: remember the current (Pancake-derived) name as the source name.
UPDATE "ProductMirror" p
SET "sourceName" = p.name
WHERE p."sourceName" IS NULL
  AND EXISTS (
    SELECT 1 FROM "ProductCategoryMembership" m
    WHERE m."productId" = p.id AND m."categoryKey" IN ('aoDai4Ta', 'aoDai6Ta')
  );

UPDATE "ProductMirror" p
SET name = pg_temp.flap_display_name(p."sourceName", f.label)
FROM (
  SELECT m."productId",
         CASE WHEN bool_or(m."categoryKey" = 'aoDai4Ta') THEN 'Áo dài 4 tà' ELSE 'Áo dài 6 tà' END AS label
  FROM "ProductCategoryMembership" m
  WHERE m."categoryKey" IN ('aoDai4Ta', 'aoDai6Ta')
  GROUP BY m."productId"
) f
WHERE p.id = f."productId"
  AND p.name IS DISTINCT FROM pg_temp.flap_display_name(p."sourceName", f.label);

DROP FUNCTION pg_temp.flap_display_name(text, text);
DROP FUNCTION pg_temp.flap_strip_code(text);
DROP FUNCTION pg_temp.vi_lower(text);
