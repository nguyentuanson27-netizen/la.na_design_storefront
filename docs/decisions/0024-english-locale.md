# ADR 0024 — English locale under `/en`

Status: implementation proposed for review. One additive migration (`ProductTranslation`); no flag or dependency
change.

## Why

The storefront was written in Vietnamese only: about 300 files carry Vietnamese copy, there was no i18n layer, and
the catalogue (product names, editorial copy) is Vietnamese data. The owner asked for an English version of the
storefront, its content pages and its product names and descriptions.

## Decision

**Routing.** Vietnamese keeps its URLs. English lives under `/en/…`. `src/proxy.ts` strips the prefix, rewrites onto
the one existing route tree and sets `x-la-locale` on the request -- always overwritten, so a browser cannot choose
it. No route is duplicated and no file moved. Chosen over a `[lang]` segment because that would have moved every page
and every test that names a path, for no behavioural gain. Chosen over a cookie because English pages need their own
URLs to be linked, shared and indexed.

- `html lang`, `og:locale`, `rel=canonical` and `hreflang` (Vietnamese is `x-default`) follow the locale
  (`createStorefrontRoute` applies `localizeMetadata` once, so no builder knows a second spelling of its URL).
- The sitemap lists every page once per language, each naming its twins; past the 50,000-URL document limit it
  lists Vietnamese only, with alternates, rather than becoming a 500.
- No automatic redirect from `Accept-Language`: a URL always means one language, which keeps caching and indexing
  predictable. The switcher in the header, mobile menu and footer links to the same page in the other language.
- `/api`, `/admin`, `/feeds`, `/voucher-link` and files never get a prefix (`localizeHref`). Admin stays Vietnamese.

**Text.** A gettext-style translator **keyed by the Vietnamese source text** (`src/i18n/translate.ts`):
`t("Giỏ hàng")` is "Cart" in English and itself in Vietnamese. Vietnamese output is the source string, so nothing
that renders or tests Vietnamese changed; a string with no English entry shows Vietnamese rather than breaking.
A key with `{name}` slots also matches text a view model has already filled in (`Còn 3` → `3 left`), recursively, so
models stay Vietnamese and their tests are untouched; the page translates what it renders. `pnpm i18n:audit` lists
sources with no entry and client code using a server-only entry; `--literals <path>` lists what to translate.

**Where English lives.** `src/i18n/catalog/*.ts`, one file per area. English for copy that Brand Config owns
(navigation, hours, policies, fulfilment, size guide) lives in `src/brand/messages*.en.ts`, because
`brand-leak.test.ts` forbids a brand string anywhere else and a catalog key *is* the Vietnamese string.

**Client vs server.** Client components get their strings from `I18nProvider`, which serializes the **client
catalog** into each English page. The long legal and About prose is server-only and never reaches the browser.
Short text is client by default, because a shared component can translate a string a server page handed it.

**Pages** receive `i18n` as `render(data, { t, rich, href, locale })` from `createStorefrontRoute`. Pages may import
only the brand layer, the routes and the brand config, so the link and hooks are re-exported through
`@/components/brand/localized-link` and `@/components/brand/localization`. `Link`, `useRouter` and `usePathname`
from `@/i18n/*` replace the `next/*` ones everywhere outside admin, so a shopper stays in their language.

**Products.** `ProductTranslation` overlays a product's name, description, material, craft details, care text and
SEO fields per language; an empty field falls back to the Vietnamese. The overlay is applied by the route loaders
and server actions to what the catalog returned, never inside the catalog's caches (they hold the Vietnamese for
everyone). Cart *views* are translated; the lines the quote and its proof are computed from never see an English
name. Admins edit it at `/admin/products/[id]/translations`.

**Static metadata.** Eight pages exported a static `metadata` const (cart, checkout, success, search, account,
login, track-order, eligible offers). A const cannot know the request's language, so they now use the page-level
`generateMetadata` like the content pages, and the route manifest says so.

## Not done, on purpose

- No customer-facing email exists in the codebase (the contact form mails the shop), so there was nothing to translate.
- Checkout line names stay as the cart's Vietnamese; the checkout model carries no slug to translate by and its
  lines feed the quote proof.
- Searching by an English product name is not supported; suggestions show the English name for a Vietnamese match.
- Money and dates keep the Vietnamese format (`1.290.000 ₫`).
- Colour and size values are POS data; common colour names are translated, the rest show as entered.
- The legal policies are a courtesy translation; the page says the Vietnamese prevails.
