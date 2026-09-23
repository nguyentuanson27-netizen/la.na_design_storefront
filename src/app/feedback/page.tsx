import { FeedbackGallery } from "@/components/brand/feedback-gallery";
import { createStorefrontRoute } from "@/routes/factory";
import { loadFeedbackRoute, type FeedbackRouteProps, type FeedbackViewModel } from "@/routes/feedback";
import { buildFeedbackMetadata } from "@/routes/metadata/feedback";

/**
 * The customer feedback gallery (spec §7.6): every configured photograph, in the configured order,
 * inside the normal site chrome. Images only -- no quotes, captions, ratings or social features.
 */

function render(data: FeedbackViewModel) {
  return (
    <div className="feedback-page">
      <h1 className="feedback-page__title">{data.title}</h1>
      <FeedbackGallery images={data.images} />
    </div>
  );
}

const route = createStorefrontRoute<FeedbackRouteProps, FeedbackViewModel>({
  load: loadFeedbackRoute,
  render,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildFeedbackMetadata(props),
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
