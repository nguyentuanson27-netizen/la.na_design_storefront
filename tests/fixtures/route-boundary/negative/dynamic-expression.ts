export async function load(target: string) {
  return import(target);
}
