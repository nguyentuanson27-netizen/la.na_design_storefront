export async function load(name: string) {
  return import(`@/commerce/${name}`);
}
