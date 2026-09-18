export const MAX_MERCHANT_OFFERS = 5_000;
export const MAX_MERCHANT_FEED_BYTES = 16 * 1024 * 1024;
/**
 * I9 raised this from eight to nine for the availability-cycle read.
 *
 * The number that matters is not the constant but the shape: every query here is flat and bounded
 * by the page, never per offer, so the whole generation costs the same nine round trips at one
 * offer as at five thousand. The cycle read is `WHERE variantId IN (...)` over the page's own
 * variants, which is the same shape as the warehouse and promotion reads beside it.
 */
export const MAX_MERCHANT_DB_ROUND_TRIPS = 9;
export const MERCHANT_FEED_CACHE_TTL_SECONDS = 300;
export const MERCHANT_FEED_FAILURE_BACKOFF_SECONDS = 60;

/**
 * U26 reads the public-feed catalog through nine flat, bounded Prisma queries. Candidate variants
 * are bounded separately from emitted offers because excluded variants still have to be audited and
 * mapped before the serializer can enforce the 5,000-offer output ceiling.
 */
export const MAX_MERCHANT_CANDIDATE_VARIANTS = 7_000;
