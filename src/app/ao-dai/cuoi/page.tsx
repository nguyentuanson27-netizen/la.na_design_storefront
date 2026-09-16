import { createStorefrontRoute } from "@/routes/factory";
import { CATEGORY_DESTINATIONS, loadCategoryRoute, renderCategoryRoute, type CategoryRouteProps, type CategoryViewModel } from "@/routes/category";
import { buildCategoryMetadata } from "@/routes/metadata/category";

const definition = CATEGORY_DESTINATIONS.aoDaiCuoi;
const route = createStorefrontRoute<CategoryRouteProps, CategoryViewModel>({ load: (props) => loadCategoryRoute(definition, props), metadata: async () => buildCategoryMetadata(definition), render: renderCategoryRoute });
export const generateMetadata = route.generateMetadata;
export default route.Page;
