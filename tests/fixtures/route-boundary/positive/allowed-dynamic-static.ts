export async function load() {
  const core = await import("@/routes/core");
  const manifest = await import(`@/routes/manifest`);
  return [core, manifest];
}
