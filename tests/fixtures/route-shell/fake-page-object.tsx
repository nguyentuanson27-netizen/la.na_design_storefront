// Negative fixture: passes a text match for the factory and for `something.Page`, while the shell
// never renders. This is what the regex check could not tell apart from a real route.
import { createStorefrontRoute } from "@/routes/factory";

const route = { Page: async () => null };

export default route.Page;
