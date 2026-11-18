/**
 * The inline script that starts Google Tag Manager, kept as plain TypeScript so a test can execute
 * it against a stand-in `window`/`document` without a browser (`tests/domain/gtm-deferred-load.test.ts`).
 *
 * It pushes `gtm.start` to the dataLayer straight away and defers inserting `gtm.js` until the
 * shopper's first interaction, or `fallbackMs` after the document's `load` event, whichever comes
 * first -- except on the cart and checkout pages (`GTM_EAGER_PATH_SOURCE`), where it loads at once.
 * See `GoogleTagManager` for why, and for what the wait does and does not cost.
 *
 * Google's nonce-aware variant: the page's script nonce is copied onto `gtm.js`. It is read when the
 * snippet runs, while the element that carries it is certainly present.
 */

import { GTM_EAGER_CHECK_GLOBAL } from "./eager-check.ts";

export { GTM_EAGER_CHECK_GLOBAL };

/**
 * Fallback delay after `load` for a visit with no interaction at all.
 *
 * Three seconds, chosen by the owner over a first value of five: the shorter it is, the fewer
 * visits end before any container request is made, and the smaller the share of Total Blocking Time
 * that is kept out of the first seconds. The gain from waiting at all has not been measured in
 * production yet, so this is the one number to move first if event counts fall after release:
 * `0` loads the container right after `load`, which is close to the behaviour before this change.
 */
export const GTM_LOAD_FALLBACK_MS = 3_000;

/**
 * Events that count as the shopper's first interaction. Listened for in the capture phase.
 *
 * `scroll` is deliberately not here: the storefront scrolls itself (`StorefrontAnchorScroll` calls
 * `scrollIntoView()` for `#san-pham` and `?scroll=san-pham` deep links, which ad links use), so a
 * scroll event does not mean a person did anything. A person scrolling starts with `touchstart`,
 * `wheel`, `keydown` or `pointerdown`, all of which are listed.
 */
export const GTM_INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/**
 * Pages on which GTM loads straight away, as before, instead of waiting for an interaction.
 *
 * These are where conversions are measured: `purchase` is published on `/checkout/success`, which
 * a shopper often reaches by a redirect from the payment page and leaves without touching, and
 * the cart and checkout publish `view_cart` and `begin_checkout`. Waiting here could lose a
 * conversion in GA4, Google Ads and TikTok, which is worth far more than the load time of a few
 * pages. An optional `/en` locale prefix is allowed. A source string, so it can be embedded.
 */
export const GTM_EAGER_PATH_SOURCE = "^/(?:en/)?(?:cart|checkout)(?:/|$)";

// The path is read when the snippet runs and again whenever `GtmRouteWatcher` calls the hook the
// snippet leaves on `window`: the root layout survives client navigation, so a shopper can reach a
// conversion page without a reload. The container still loads at most once.

export function buildGtmLoaderSnippet(
  containerId: string,
  fallbackMs: number = GTM_LOAD_FALLBACK_MS,
  eagerPathSource: string = GTM_EAGER_PATH_SOURCE,
): string {
  return `(function(w,d,s,l,i,ms,evs,eager,hook){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var n=d.querySelector('[nonce]'),
c=n&&(n.nonce||n.getAttribute('nonce')),started=false;
function load(){if(started)return;started=true;
for(var k=0;k<evs.length;k++)w.removeEventListener(evs[k],load,true);
var f=d.getElementsByTagName(s)[0],j=d.createElement(s),
dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;
c&&j.setAttribute('nonce',c);f.parentNode.insertBefore(j,f);}
var re=new RegExp(eager);function check(){if(!started&&re.test(w.location.pathname))load();}
w[hook]=check;check();if(started)return;
for(var m=0;m<evs.length;m++)w.addEventListener(evs[m],load,{capture:true,passive:true});
function arm(){setTimeout(load,ms);}
if(d.readyState==='complete')arm();else w.addEventListener('load',arm,{once:true});
})(window,document,'script','dataLayer',${JSON.stringify(containerId)},${Number(fallbackMs)},${JSON.stringify(GTM_INTERACTION_EVENTS)},${JSON.stringify(eagerPathSource)},${JSON.stringify(GTM_EAGER_CHECK_GLOBAL)});`;
}
