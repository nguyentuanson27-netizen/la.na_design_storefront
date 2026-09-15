import { createStorefrontRoute } from "@/routes/factory";
import { loadSearchRoute, type SearchRouteProps, type SearchViewModel } from "@/routes/search";
import { buildSearchMetadata } from "@/routes/metadata/search";

/** The search entry form. `/shop` owns the query and the results it submits to. */

// The view model is empty, so the render prop takes nothing: naming an argument it never reads
// would only invite someone to start reading one.
function render() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Tìm / Khám phá</p>
      <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        TÌM KIẾM
      </h1>
      <form className="mt-12 flex max-w-4xl border-b border-black" action="/shop" method="get" role="search">
        <label className="sr-only" htmlFor="site-search">Tìm sản phẩm</label>
        <input
          className="min-w-0 flex-1 bg-transparent py-4 text-xl outline-none placeholder:text-black/40 focus-visible:outline-2 focus-visible:outline-offset-4 md:text-3xl"
          id="site-search"
          name="q"
          placeholder="Sơ mi, quần, áo khoác…"
          type="search"
        />
        <button className="px-4 text-xs font-semibold uppercase tracking-[0.14em]" type="submit">
          Tìm kiếm
        </button>
      </form>
    </div>
  );
}

const route = createStorefrontRoute<SearchRouteProps, SearchViewModel>({
  load: loadSearchRoute,
  render,
});

export const metadata = buildSearchMetadata();
export default route.Page;
