import { handleProductImageRequest } from "@/integrations/pancake/product-image-handler";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleProductImageRequest(request);
}
