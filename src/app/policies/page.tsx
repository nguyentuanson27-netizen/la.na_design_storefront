import Link from "next/link";

import { createStorefrontRoute } from "@/routes/factory";
import { loadPoliciesRoute, type PoliciesRouteProps } from "@/routes/policies";
import type { PolicyHubViewModel } from "@/routes/evergreen-model";
import { buildPoliciesMetadata } from "@/routes/metadata/policies";

/**
 * A7b — one hub for the policy topics the footer contract requires.
 *
 * An index rather than a second policy. Shipping, returns and contact render their policies in
 * full; this page links to them and states, from the same constants, the three topics that have no
 * page of their own. Nothing here is authored: every line a reader sees is a member of Brand
 * Config, so the hub cannot drift from the pages it points at.
 *
 * Each section carries its topic id as an element id. Those anchors are a published contract — a
 * footer link to `/policies#khieu-nai` has to keep landing — so they live in the view model and are
 * pinned by a test rather than typed into markup here.
 *
 * This is not the footer redesign: F9a owns the footer's grouping and visuals. What this
 * establishes is that the destinations exist and are truthful.
 */

const POLICY_LINK =
  "underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4";

function render(data: PolicyHubViewModel) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Chính sách</p>
      <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
        Thông tin &amp; chính sách
      </h1>

      <div className="mt-16 grid max-w-3xl gap-12">
        {data.topics.map((topic) => (
          <section key={topic.id} id={topic.id} aria-labelledby={`${topic.id}-heading`}>
            <h2
              id={`${topic.id}-heading`}
              className="font-serif text-2xl tracking-[-0.03em] md:text-3xl"
            >
              {topic.title}
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-7 text-black/70">{topic.detail}</p>
            {topic.note === null ? null : (
              <p className="mt-2 max-w-2xl text-base leading-7 text-black/70">{topic.note}</p>
            )}
            <p className="mt-4">
              <Link className={POLICY_LINK} href={topic.href}>
                {topic.linkLabel}
              </Link>
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}

const route = createStorefrontRoute<PoliciesRouteProps, PolicyHubViewModel>({
  load: loadPoliciesRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildPoliciesMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
