import { createStorefrontRoute } from "@/routes/factory";
import {
  loadNewArrivalsRoute,
  type NewArrivalsRouteProps,
  type NewArrivalsViewModel,
} from "@/routes/new-arrivals";
import { buildNewArrivalsMetadata } from "@/routes/metadata/new-arrivals";

/** The drop announcement. No product listing: `/shop` owns filtering and ordering. */

// The view model is empty, so the render prop takes nothing: naming an argument it never reads
// would only invite someone to start reading one.
function render() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Drop / 01</p>
      <h1 className="mt-4 max-w-6xl text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        HÀNG MỚI
      </h1>
      <div className="mt-12 border-t border-black/20 pt-8">
        <p className="max-w-2xl font-serif text-2xl leading-snug md:text-3xl">
          Những phom dáng, chất liệu và lớp trang phục theo mùa mới nhất — được ra mắt với số lượng chọn lọc.
        </p>
      </div>
    </div>
  );
}

const route = createStorefrontRoute<NewArrivalsRouteProps, NewArrivalsViewModel>({
  load: loadNewArrivalsRoute,
  metadata: (props) => buildNewArrivalsMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
