// Negative fixture, and deliberately a strict one: the factory is imported and called, but what is
// exported is an object literal that borrows `Page` from it.
//
// This one really does reach the shell. It is rejected anyway, because an object literal is exactly
// the shape the fake uses, and telling "borrows the real Page" from "fabricates one" needs type
// resolution the checker does not do. Requiring the direct form costs a page nothing -- every route
// in this repo already writes it -- and is what keeps the fake rejectable.
import { createStorefrontRoute } from "@/routes/factory";

const real = createStorefrontRoute<Record<string, never>, Record<string, never>>({
  load: async () => ({}) as never,
  render: () => null,
});

const route = { Page: real.Page, extra: true };

export default route.Page;
