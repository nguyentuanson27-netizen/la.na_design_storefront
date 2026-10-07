import { parsePdpImageWidth } from "@/commerce/product-image-delivery";
import { fetchAndCompressPancakeProductImage } from "@/integrations/pancake/product-image-delivery";

export const runtime = "nodejs";

function errorResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const keys = [...searchParams.keys()];
  if (
    keys.some((key) => key !== "src" && key !== "w") ||
    searchParams.getAll("src").length !== 1 ||
    searchParams.getAll("w").length !== 1
  ) {
    return errorResponse(400);
  }

  const src = searchParams.get("src");
  const width = parsePdpImageWidth(searchParams.get("w"));
  if (src === null || width === null) return errorResponse(400);

  const result = await fetchAndCompressPancakeProductImage(src, width);
  if (!result.ok) {
    switch (result.reason) {
      case "UNTRUSTED_URL":
        return errorResponse(400);
      case "TOO_LARGE":
      case "UNSUPPORTED_IMAGE":
      case "OUTPUT_TOO_LARGE":
        return errorResponse(422);
      case "FETCH_FAILED":
        return errorResponse(502);
    }
  }

  return new Response(result.image.bytes, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Content-Length": String(result.image.bytes.byteLength),
      "Content-Type": result.image.mimeType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
