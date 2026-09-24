import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { createStorefrontRoute } from "@/routes/factory";
import { loadSearchRoute, type SearchRouteProps, type SearchViewModel } from "@/routes/search";
import { buildSearchMetadata } from "@/routes/metadata/search";

/** The search entry form. `/shop` owns the query and the results it submits to. */

// The view model is empty, so the render prop takes nothing: naming an argument it never reads
// would only invite someone to start reading one.
function render() {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Tìm kiếm" }]} />
      <PageHeader eyebrow="Khám phá" title="Tìm kiếm" />
      <form className="mt-8 flex max-w-4xl border-b border-[#3B2219]" action="/shop" method="get" role="search">
        <label className="sr-only" htmlFor="site-search">Tìm sản phẩm</label>
        <input
          className="min-w-0 flex-1 bg-transparent py-4 font-display text-xl text-[#2A1810] outline-none placeholder:text-[#3B2219]/40 focus-visible:outline-2 focus-visible:outline-offset-4 md:text-2xl"
          id="site-search"
          name="q"
          placeholder="Sơ mi, quần, áo khoác…"
          type="search"
        />
        <button className="px-4 text-xs font-semibold uppercase tracking-[0.14em]" type="submit">
          Tìm kiếm
        </button>
      </form>
    </PageShell>
  );
}

const route = createStorefrontRoute<SearchRouteProps, SearchViewModel>({
  load: loadSearchRoute,
  render,
});

export const metadata = buildSearchMetadata();
export default route.Page;
