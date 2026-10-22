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
2. Browse the storefront in production with DevTools open, and let real traffic run for a few days.
   Accept GTM consent paths, open the Pancake chat, add to cart and check out once.
3. Read the reports:

   ```bash
   docker compose logs app --since 72h | grep '"csp.violation"'
   ```

   Each line names the directive, the blocked origin (or `inline` / `eval`), the page path and the
   script that caused it. Lines are capped at 60 a minute per process; `csp.violation_suppressed`
   says how many were dropped.
4. Expect noise from browser extensions (`chrome-extension:` sources and similar). A violation whose
   `source` is one of the site's own scripts, GTM, Meta, Zalo, OpenAI or Pancake must be understood
   before enforcing. A GTM Custom HTML tag that injects inline script without the nonce shows up
   here as `blocked: "inline"` with a `www.googletagmanager.com` source.
5. Set `enforce`, restart, and repeat step 2 briefly.

Rollback: set `off` (or back to `report-only`) and restart the app.

## Limits

- The prerendered `/_global-error` page (shown only when the root layout itself fails) has no
  nonce, so under `enforce` its scripts do not run. Its HTML still renders.
- `style-src` still allows inline styles; Next and the chat widget rely on them.
- The GTM container must not use Custom JavaScript variables: they need `'unsafe-eval'`, which
  neither policy grants (unchanged from before).
