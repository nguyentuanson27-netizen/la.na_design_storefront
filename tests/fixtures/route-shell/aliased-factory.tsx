// Positive fixture: the factory under a different local name, and the binding under another. A
// module may name these whatever it likes; what matters is where `Page` came from.
import { createStorefrontRoute as buildRoute } from "@/routes/factory";

const storefront = buildRoute<Record<string, never>, Record<string, never>>({
  load: async () => ({}) as never,
  render: () => null,
});

export default storefront.Page;
