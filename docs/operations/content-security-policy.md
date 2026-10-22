# Content-Security-Policy: script nonce rollout

Every response carries the baseline policy from `next.config.mjs`. It allows inline scripts
(`'unsafe-inline'`), because a header baked at build time cannot know a per-request nonce, so on its
own it does not stop an injected `<script>` from running.

Page loads also carry a stricter policy built per request by `src/proxy.ts`
(`src/security/script-nonce-policy.ts`): the baseline's directives, with `script-src` led by a fresh
`'nonce-…'` and `'strict-dynamic'`. Next stamps the nonce on its own scripts; the site chrome passes it
to the inline snippets it renders (tracking bootstrap, GTM, Meta pixel, ChatGPT Ads pixel). Scripts
those load (gtm.js, fbevents.js, the Pancake chat and Zalo loaders inserted from the app bundle) are
trusted through `'strict-dynamic'`. The GTM snippet copies the nonce onto gtm.js so the container's
Custom HTML tags can carry it.

Both policies are enforced when both are sent, so the baseline's host list still bounds what any
script may load. The stricter policy only removes permissions.

## Modes (`LA_CSP_STRICT_SCRIPTS`, runtime)

| Value | Header | Effect |
|---|---|---|
| `report-only` (default) | `Content-Security-Policy-Report-Only` | Nothing blocked. Browsers report what enforcing would block. |
| `enforce` | `Content-Security-Policy` | Inline scripts without the nonce no longer run. |
| `off` | — | Baseline only, as before this change. |

An unrecognised value is treated as `report-only`. Changing the value needs an app restart, not a
rebuild.

## Rollout

1. Deploy with `report-only`.
2. Exercise every surface in production with DevTools open, then let real traffic run for a few
   days. Each of these must be covered, on a phone-width window as well as desktop:
   - storefront: home, listings, a product page, cart, checkout through to the success page, order
     tracking, and an unknown product slug (the 404 rewrite);
   - accounts: sign-in and `/account`;
   - admin, signed in as an admin: products (directory and one product), collections, new
     arrivals, promotions (campaigns, shipping, gift-quantity) and size guides;
   - the live integrations: accept the GTM consent paths so its tags fire, open the Pancake chat,
     and land once from a Zalo and a Meta ad link.

   CI already proves the nonce wiring on every pull request: `tests/a11y-runtime/csp-enforce.spec.ts`
   builds the app for production, starts it under `enforce`, and loads the storefront pages,
   sign-in, the 404 rewrite and every admin page, failing on any violation or missing nonce. It runs
   the reviewed GTM container's TikTok Base tag from a stand-in gtm.js and stubs every other
   third-party script, so the real GTM container, Pancake chat and Zalo tracker are only proven here.
3. Read the reports:

   ```bash
   docker compose logs app --since 72h | grep '"csp\.violation'
   ```

   Each `csp.violation` line names the directive, the blocked origin (or `inline` / `eval`), the page
   path and the script that caused it. The endpoint is public, so the log is budgeted: 10 lines a
   minute per client (by the proxy-owned client IP, which is never logged) and 60 a minute per
   process overall. The first report a window drops logs `csp.violation_suppression_started` at
   once, with `reason` `byClient` (one sender over its share) or `byWindow` (the whole window full),
   so a drop is on record even if no report ever arrives after it. When the next window opens, a
   `csp.violation_suppressed` line gives that window's totals for both.

   **A quiet log is evidence only when nothing was suppressed.** Any `byWindow` drop means real
   reports may have been lost in that window: find out why (a broken page, or a flood from many
   addresses) and repeat the observation before enforcing. A persistent flood is better stopped at
   the edge: a request rate limit on `/api/csp-report` in nginx-proxy-manager (`limit_req`) keeps it
   from reaching the app at all.
4. Expect noise from browser extensions (`chrome-extension:` sources and similar). A violation whose
   `source` is one of the site's own scripts, GTM, Meta, Zalo, OpenAI or Pancake must be understood
   before enforcing. Scripts a trusted script creates -- gtm.js inserting a Custom HTML tag's
   `<script>`, inline or not -- are allowed by `'strict-dynamic'` (checked in Chromium), but markup a
   tag writes with `document.write` is parsed like page HTML and is blocked; it shows up here as
   `blocked: "inline"` with a `www.googletagmanager.com` source.
5. Set `enforce`, restart, and repeat step 2 briefly.

Rollback: set `off` (or back to `report-only`) and restart the app.

## Limits

- The prerendered `/_global-error` page (shown only when the root layout itself fails) has no
  nonce, so under `enforce` its scripts do not run. Its HTML still renders.
- `style-src` still allows inline styles; Next and the chat widget rely on them.
- The GTM container must not use Custom JavaScript variables: they need `'unsafe-eval'`, which
  neither policy grants (unchanged from before).
