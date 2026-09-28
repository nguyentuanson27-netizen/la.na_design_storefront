import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { BRAND } from "@/brand";

export const dynamic = "force-static";

const ASSET_PATH = path.join(process.cwd(), "public/brand", `${BRAND.identity.socialCardSlug}.png`);

export function GET() {
  if (existsSync(ASSET_PATH)) {
    const file = readFileSync(ASSET_PATH);
    return new Response(file, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}
