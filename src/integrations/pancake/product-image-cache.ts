import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CachedProductImage = Readonly<{
  bytes: Uint8Array;
  mimeType: "image/webp" | "image/avif";
}>;

/**
 * Where encoded PDP photographs are kept between requests, so a photograph is fetched from Pancake
 * and run through Sharp once per width and format rather than once per visitor. Best-effort by
 * contract: a read that fails is a miss and a write that fails is dropped, so a full or read-only
 * disk degrades to the uncached endpoint and never to an error.
 */
export type ProductImageCache = Readonly<{
  read: (key: string, mimeType: CachedProductImage["mimeType"]) => Promise<CachedProductImage | null>;
  write: (key: string, image: CachedProductImage) => Promise<void>;
}>;

const EXTENSION_BY_TYPE = { "image/webp": "webp", "image/avif": "avif" } as const;
const MEBIBYTE = 1024 * 1024;
/** Pruning stops once the cache is back under this share of its budget, so it does not run per write. */
const PRUNE_TARGET_RATIO = 0.9;

function fileStem(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * A directory of `<sha256(key)>.<webp|avif>` files bounded to `maxBytes`.
 *
 * Writes go to a temporary name and are renamed into place, so a reader never sees half a file and
 * two processes writing one key leave one whole file. Every hit refreshes the file's mtime, and once
 * the directory outgrows its budget the least recently used files are removed first. The running
 * size is an estimate between prunes; each prune recounts it from the directory.
 */
export function createDiskProductImageCache({
  directory,
  maxBytes,
}: Readonly<{ directory: string; maxBytes: number }>): ProductImageCache {
  let ready: Promise<void> | null = null;
  let totalBytes = 0;
  let pruning: Promise<void> | null = null;
  let warned = false;

  const warnOnce = (error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(`[product-image-cache] ${directory} is not usable; serving uncached:`, error);
  };

  const listEntries = async () => {
    const names = await readdir(directory);
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith(".webp") || name.endsWith(".avif"))
        .map(async (name) => {
          try {
            const info = await stat(join(directory, name));
            return { path: join(directory, name), size: info.size, mtimeMs: info.mtimeMs };
          } catch {
            return null; // removed by a concurrent prune
          }
        }),
    );
    return entries.filter((entry) => entry !== null);
  };

  const ensureReady = () => {
    ready ??= (async () => {
      await mkdir(directory, { recursive: true });
      totalBytes = (await listEntries()).reduce((sum, entry) => sum + entry.size, 0);
    })();
    return ready;
  };

  const prune = () => {
    pruning ??= (async () => {
      try {
        const entries = (await listEntries()).sort((left, right) => left.mtimeMs - right.mtimeMs);
        let size = entries.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of entries) {
          if (size <= maxBytes * PRUNE_TARGET_RATIO) break;
          try {
            await unlink(entry.path);
            size -= entry.size;
          } catch {
            // already gone
          }
        }
        totalBytes = size;
      } catch (error) {
        warnOnce(error);
      } finally {
        pruning = null;
      }
    })();
    return pruning;
  };

  return {
    async read(key, mimeType) {
      try {
        await ensureReady();
        const path = join(directory, `${fileStem(key)}.${EXTENSION_BY_TYPE[mimeType]}`);
        const bytes = await readFile(path);
        const now = new Date();
        void utimes(path, now, now).catch(() => {});
        return { bytes: new Uint8Array(bytes), mimeType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") warnOnce(error);
        return null;
      }
    },

    async write(key, image) {
      try {
        await ensureReady();
        const path = join(directory, `${fileStem(key)}.${EXTENSION_BY_TYPE[image.mimeType]}`);
        const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(temporary, image.bytes);
        await rename(temporary, path);
        totalBytes += image.bytes.byteLength;
        if (totalBytes > maxBytes) await prune();
      } catch (error) {
        warnOnce(error);
      }
    },
  };
}

let defaultCache: ProductImageCache | null | undefined;

/**
 * The cache the production endpoint uses. On in production builds only -- tests and `next dev` keep
 * the uncached contract -- and switched off entirely with `PRODUCT_IMAGE_CACHE_DIR=off`.
 *
 * `PRODUCT_IMAGE_CACHE_DIR` (default `.next/cache/product-images`) should be a persistent volume so a
 * deploy does not re-encode the catalogue; `PRODUCT_IMAGE_CACHE_MAX_MB` bounds it (default 2048).
 */
export function readDefaultProductImageCache(): ProductImageCache | null {
  if (defaultCache !== undefined) return defaultCache;
  const configuredDirectory = process.env.PRODUCT_IMAGE_CACHE_DIR?.trim();
  if (configuredDirectory === "off" || process.env.NODE_ENV !== "production") {
    defaultCache = null;
    return defaultCache;
  }
  const configuredMegabytes = Number(process.env.PRODUCT_IMAGE_CACHE_MAX_MB ?? "");
  const megabytes =
    Number.isFinite(configuredMegabytes) && configuredMegabytes > 0 ? configuredMegabytes : 2048;
  defaultCache = createDiskProductImageCache({
    directory:
      configuredDirectory && configuredDirectory.length > 0
        ? configuredDirectory
        : join(process.cwd(), ".next", "cache", "product-images"),
    maxBytes: Math.floor(megabytes * MEBIBYTE),
  });
  return defaultCache;
}
