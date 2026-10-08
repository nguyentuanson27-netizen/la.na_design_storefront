/**
 * Where to send a shopper once they have signed in: back to the page that sent them, never
 * somewhere an attacker chose.
 *
 * The `next` query parameter is attacker-controllable — anyone can mail a link to `/login?next=…`.
 * A redirect to it is therefore only safe for a path on this site. Anything else (another origin,
 * a protocol-relative `//host`, a backslash that browsers read as a slash, a scheme, control
 * characters) is refused and the shopper simply stays where they are.
 */

const MAX_RETURN_PATH_LENGTH = 512;

/** The same-site path in `value`, or `null` when it is missing or not provably one. */
export function resolveSafeReturnPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // Backslashes and control characters are normalised by browsers into forms the checks above
  // never saw ("/\\evil.example" navigates off-site), so they are refused outright.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  // Signing in from the sign-in page itself would loop.
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login#")) return null;
  return value;
}

/** `/login` that returns to `returnTo` afterwards; plain `/login` when it is not a safe path. */
export function buildLoginHref(returnTo: string): string {
  const safe = resolveSafeReturnPath(returnTo);
  return safe === null ? "/login" : `/login?next=${encodeURIComponent(safe)}`;
}
