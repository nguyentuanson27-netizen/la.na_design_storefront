# Phase C — G2 source verification notes

Gate G2 requires checking current official documentation / authoritative sources for
version-sensitive APIs before implementation, instead of relying on memory.

`nextjs.org` is blocked by this environment's network egress proxy, so for the two Next.js APIs the
**installed package's own type declarations and doc comments** were used as the authoritative source.
They ship with the exact version this repo runs, which is a stronger guarantee than a docs site that
describes whatever version is current at read time. Where a behavioural rule is not expressible in
types, it was corroborated by web search.

Versions verified in place: `next@16.2.11`, `react@19.2.0`, `typescript@5.9.3`, Node `v22.22.2`.

## 1. Next.js Metadata API

Checked:

- `node_modules/next/dist/lib/metadata/types/metadata-interface.d.ts` — `Metadata`,
  `ResolvedMetadata`, `ResolvingMetadata` (`= Promise<ResolvedMetadata>`) are exported from `next`.
- Baseline usage in this repo: `src/app/page.tsx`, `src/app/shop/[slug]/layout.tsx`.
- Web search (nextjs.org unreachable) for the one rule that is not in the type system: a route
  segment may **not** export both `metadata` and `generateMetadata`; Next fails the build.

Facts relied on:

| Fact | Consequence for this PR |
|---|---|
| A segment cannot export both `metadata` and `generateMetadata` | This is what makes the factory's two overloads a real contract rather than a style choice. `page` mode yields `generateMetadata`; `static` mode uses `export const metadata`; they can never coexist in one file, so the manifest's three modes are mutually exclusive by construction. |
| `generateMetadata` may be `async` and return `Promise<Metadata>` | The verifier must unwrap `await` before deciding whether the returned expression is a direct builder call. |
| Metadata may be exported from `layout.tsx` | `layout` mode is legitimate; PDP keeps metadata in `layout.tsx` and its `page.tsx` exports none. Not normalized. |
| `params` / `searchParams` are `Promise`-typed in this major | Route props stay `Promise`-shaped; the factory is generic over props and does not unwrap them. |

## 2. `connection()`

Checked `node_modules/next/dist/server/request/connection.d.ts` and `node_modules/next/server.d.ts`:

```ts
// next/dist/server/request/connection.d.ts
/**
 * This function allows you to indicate that you require an actual user Request before continuing.
 *
 * During prerendering it will never resolve and during rendering it resolves immediately.
 */
export declare function connection(): Promise<void>;

// next/server.d.ts
export { connection } from 'next/dist/server/request/connection'
```

Facts relied on:

- `connection()` is exported from **`next/server`**, and `next/server` is on the boundary verifier's
  deny list by design (spec 04 §6.3). So after route migration a page may not call it directly; the
  dynamic-rendering requirement belongs to the route layer.
- **Assumption affecting this PR:** baseline pages (`src/app/page.tsx`,
  `src/app/shop/[slug]/layout.tsx`, cart/checkout) still import `connection` from `next/server`
  today. That is precisely why Task 12 stays fixture-only: switching on a live repository-wide scan
  in this PR would fail on unmigrated pages. Migration is Phase D/E work, gated live at T32B.

## 3. TypeScript `ts.resolveModuleName`

Checked `node_modules/typescript/lib/typescript.d.ts`:

```ts
// line 9330
function resolveModuleName(
  moduleName: string,
  containingFile: string,
  compilerOptions: CompilerOptions,
  host: ModuleResolutionHost,
  cache?: ModuleResolutionCache,
  redirectedReference?: ResolvedProjectReference,
  resolutionMode?: ResolutionMode,
): ResolvedModuleWithFailedLookupLocations;

// line 7336
interface ResolvedModuleWithFailedLookupLocations {
  readonly resolvedModule: ResolvedModuleFull | undefined;
}
```

Facts relied on:

- The signature matches spec §6.2 exactly; `ts.sys` satisfies `ModuleResolutionHost`.
- Compiler options come from `ts.readConfigFile` + `ts.parseJsonConfigFileContent` on the real
  `tsconfig.json`, so `paths` (`@/*` → `./src/*`), `moduleResolution: "bundler"` and
  `allowImportingTsExtensions` are the project's own, not guessed.
- **Assumption affecting this PR:** `moduleResolution: "bundler"` resolves the `@/*` alias through
  `paths`. A resolution cache is not used; the fixture matrix is small and correctness beats speed.

## 4. Node cannot import `.tsx` — verified, not assumed

`node --experimental-strip-types` erases types but does **not** transform JSX, and refuses the
extension outright:

```
$ node --experimental-strip-types run.ts   # importing a .tsx
ERR_UNKNOWN_FILE_EXTENSION
```

A `.tsx` with no JSX in it fails the same way; the extension itself is rejected.

This repo's entire test suite runs on that loader (`pnpm test:domain` →
`node --experimental-strip-types --test tests/domain/*.test.ts`), so **a `.tsx` module cannot be
imported by any test here.**

Consequence, and the one place this PR departs from the spec's letter: spec §4 names the file
`src/routes/core.tsx`. This PR implements `src/routes/core.ts`, building elements with
`React.createElement` instead of JSX.

What the spec actually requires is that `sealRoute`, `unsealRoute` and `StorefrontRoute` live in
**one module**, so `unsealRoute` is genuinely module-private. That requirement is met in full — and
splitting the file to get a JSX-free importable half would have broken it, since `unsealRoute` would
have to be exported across the seam. The choice is therefore between the spec's file extension and
Task 10's acceptance criteria being executed rather than grepped. This PR keeps the executable
tests: every Task 10 criterion is verified by calling real code.

Renaming to `.tsx` is a one-line change if the reviewer prefers the spec's letter, but the shell's
tests would then have to become source-text assertions.
