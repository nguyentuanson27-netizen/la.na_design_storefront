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
  predictable. The one exception is a first-visit redirect of the bare home page for visitors outside Vietnam
  (ADR 0025). The switcher in the header, mobile menu and footer links to the same page in the other language.
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

**Prices in dollars.** The English pages *display* US dollars at one fixed rate, 20,000 ₫ to the dollar
(`src/brand/currency.config.ts`; change the number there when it drifts), and then show the nearest price ending in
.49 or .99 (`priceEndingsInCents`): 500,000 ₫ is $24.99, 1,290,000 ₫ is $64.49, 200K is $9.99. Zero stays $0.00 and
anything under a quarter of a dollar is not rounded up to .49; a tie goes to the lower price. The rate was 26,000 ₫ with
plain two-decimal rounding until the change of 2026-11-18. The ending belongs to *prices* (a unit price, a struck-through list price, a shipping fee, a voucher's amount), and whatever is
built from prices is calculated from the prices shown, in cents (`src/i18n/usd-bill.ts`, applied by `usdCart` and `usdCheckout`
when the page is English): a line total is the quantity times the unit price shown (summed over a benefit quote's price
segments), the subtotal is the sum of the lines, "order value" is the subtotal plus the cart-level discounts, the discount rows
share that difference (every row but the last is its own amount to the cent, the last takes the remainder), and the total is the
subtotal plus the displayed shipping. So 4 x $10.49 reads $41.96, never $40.99, and a total is generally not itself a .49/.99
figure. The cart page, the cart drawer and checkout (lines, subtotal, shipping, total, the bill and the list-price savings) follow
this; the numbers they need travel beside the Vietnamese texts in the view models (`CartLineView.bill`, `OrderSummaryView.facts`,
`CheckoutLineView.unitPriceVnd`, ...). Two rules keep the vouchers consistent from the picker to the held checkout. A
merchandise voucher is shared out in dong over the units it touched, so the quote's unit prices already carry it; priced one
by one in dollars those shares would not add up to the amount the picker showed. The English checkout therefore shows the
lines at their price *before* the voucher and the voucher as a discount row of its own, whose amount is the dollar price of
what it took off (the picker's figure). (Several vouchers can lower one line, one ledger step each: the price before them is the input of the first, and what they
took off is counted over every step, in dong as well as in dollars. The panel's rows are shared out of that one dollar amount.)
And a shipping voucher is printed as the whole fee followed by what it waived, so the
rows add up as printed. The voucher picker measures its summary from the bill's goods total and re-applies that to every
answer of its server actions (`usdVoucherPicker`, `VoucherPickerModel.usdBasisCents`), so choosing or clearing a voucher
never moves it. A "-NN%" badge is measured on the dollar pair the buyer sees (the struck price and the price beside it), not on
the dong quote, so it can differ by a point or more from the Vietnamese page's. Not recomputed that way, and so converted one by one like any other text: the picker's cards, the "buy N
more" nudges and promotion banners, and product listings and pages (single prices, nothing to add up). It is a display rate only: the cart, the
order, the bank transfer, structured data (`priceCurrency: VND`), analytics and every server-side figure stay in
dong. The view models keep formatting dong, so the conversion is done on the text, in the English translator
(`src/i18n/money.ts`): any amount written with `₫` that passes through `t()` becomes a dollar price. Components that print a
price must therefore pass it through `t()`. Text that has to stay in dong writes `VND` instead (the price-range
limits, the "charged in VND" line under the checkout and order-tracking totals, `DongNote`).

**Campaign names.** Promotion, gift, shipping and voucher campaigns are named by hand in Vietnamese in the admin, so
their English cannot live in the catalog. `CampaignNameTranslation` maps a Vietnamese name *text* to its English
(one row serves every campaign that carries the name), entered in `/admin/promotions/name-translations`, which lists
each distinct name in use once. It is a lookup of its own -- `RequestI18n.campaignName` on the server, `useCampaignName`
in the browser -- and is never merged into the catalog: a campaign called "Ưu đãi" must not turn the interface's own
"Ưu đãi" label into the campaign's English. A name with no row is read through the catalog as written (so "Giảm 50K"
still shows its dollar figure).

What reaches the browser is limited to names the storefront shows to anyone: `readPublic` returns a translation only if
a campaign of that name is public, switched on, started, not over and on this shop (`PANCAKE_SHOP_ID`). Vouchers and freeship
campaigns carry the shop; promotion and gift campaigns do not, so they are placed by what they apply to: a promotion by its
product or variant targets, a gift or tier campaign over a fixed product set by its frozen products, and one over every paid
line or a category (which apply to whatever the storefront sells) to every shop. A private voucher's name, a switched-off, not-yet-started or ended campaign's, another shop's,
and a translation left behind by a renamed or deleted campaign stay on the server; the admin marks names only private
vouchers carry as not translatable. The rows are read for English requests only and held 30 s. Display only: quotes, orders
and the checkout's proofs keep the campaign's own name.

**Size guide.** The chart's titles, row labels and notes are in the brand catalog, in the client part of it, because the
product page's size sheet and dialog are client components. An artwork uploaded for a guide in the admin is a picture and
stays as drawn.

## Not done, on purpose

- No customer-facing email exists in the codebase (the contact form mails the shop), so there was nothing to translate.
- Checkout line names stay as the cart's Vietnamese; the checkout model carries no slug to translate by and its
  lines feed the quote proof.
- Searching by an English product name is not supported; suggestions show the English name for a Vietnamese match.
- Dates keep the Vietnamese format. The shop-by-price filter is entered in dong (its label says so), and the
  bank-transfer amount on the order page stays in dong.
- Colour and size values are POS data; common colour names are translated, the rest show as entered.
- The legal policies are a courtesy translation; the page says the Vietnamese prevails.
