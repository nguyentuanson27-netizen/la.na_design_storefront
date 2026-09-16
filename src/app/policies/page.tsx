import Link from "next/link";

import { createStorefrontRoute } from "@/routes/factory";
import type { PolicyHubViewModel } from "@/routes/evergreen-model";
import { buildPoliciesMetadata } from "@/routes/metadata/policies";
import { loadPoliciesRoute, type PoliciesRouteProps } from "@/routes/policies";

/**
 * A7b — one hub for all eleven footer policy topics.
 *
 * Dedicated shipping, returns and contact pages remain the full authority for those topics; the hub
 * links to them. Owner-approved legal/static clauses render here from `policy.config.ts`. The page
 * contains presentation only: no payment, privacy, pricing or legal sentence is authored in JSX.
 *
 * Each topic keeps a stable element id. The five newly approved policy topics use their hub anchor
 * as their full destination; dedicated-page topics keep their existing links.
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

      <div className="mt-16 grid max-w-3xl gap-16">
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

            {topic.sections.length === 0 ? null : (
              <div className="mt-8 grid gap-8">
                {topic.sections.map((section) => (
                  <div key={section.heading}>
                    <h3 className="font-serif text-xl tracking-[-0.02em] md:text-2xl">
                      {section.heading}
                    </h3>
                    {section.paragraphs.map((paragraph) => (
                      <p
                        key={paragraph}
                        className="mt-3 max-w-2xl text-base leading-7 text-black/70"
                      >
                        {paragraph}
                      </p>
                    ))}
                    {section.items.length === 0 ? null : (
                      <ul className="mt-3 max-w-2xl list-disc space-y-2 pl-5 text-base leading-7 text-black/70">
                        {section.items.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}

            {topic.linkLabel === null ? null : (
              <p className="mt-6">
                <Link className={POLICY_LINK} href={topic.href}>
                  {topic.linkLabel}
                </Link>
              </p>
            )}
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
