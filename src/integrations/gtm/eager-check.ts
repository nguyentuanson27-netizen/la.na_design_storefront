/**
 * The name of the hook the GTM loader snippet puts on `window` so the page can tell it that the
 * route changed. Kept in its own tiny module, apart from the snippet builder, so the client
 * component that calls it does not pull the builder (and its vendor strings) into the browser bundle.
 */
export const GTM_EAGER_CHECK_GLOBAL = "laGtmEagerCheck";
