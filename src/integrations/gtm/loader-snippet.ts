/**
 * The inline script that starts Google Tag Manager, kept as plain TypeScript so a test can execute
 * it against a stand-in `window`/`document` without a browser (`tests/domain/gtm-deferred-load.test.ts`).
 *
 * It pushes `gtm.start` to the dataLayer straight away and defers inserting `gtm.js` until the
 * shopper's first interaction, or `fallbackMs` after the document's `load` event, whichever comes
 * first. See `GoogleTagManager` for why, and for what the wait does and does not cost.
 *
 * Google's nonce-aware variant: the page's script nonce is copied onto `gtm.js`. It is read when the
 * snippet runs, while the element that carries it is certainly present.
 */

/** Fallback delay after `load` for a visit with no interaction at all. */
export const GTM_LOAD_FALLBACK_MS = 5_000;

/** Events that count as the shopper's first interaction. Listened for in the capture phase. */
export const GTM_INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll", "wheel"] as const;

export function buildGtmLoaderSnippet(containerId: string, fallbackMs: number = GTM_LOAD_FALLBACK_MS): string {
  return `(function(w,d,s,l,i,ms,evs){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var n=d.querySelector('[nonce]'),
c=n&&(n.nonce||n.getAttribute('nonce')),started=false;
function load(){if(started)return;started=true;
for(var k=0;k<evs.length;k++)w.removeEventListener(evs[k],load,true);
var f=d.getElementsByTagName(s)[0],j=d.createElement(s),
dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;
c&&j.setAttribute('nonce',c);f.parentNode.insertBefore(j,f);}
for(var m=0;m<evs.length;m++)w.addEventListener(evs[m],load,{capture:true,passive:true});
function arm(){setTimeout(load,ms);}
if(d.readyState==='complete')arm();else w.addEventListener('load',arm,{once:true});
})(window,document,'script','dataLayer',${JSON.stringify(containerId)},${Number(fallbackMs)},${JSON.stringify(GTM_INTERACTION_EVENTS)});`;
}
