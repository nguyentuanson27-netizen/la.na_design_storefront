# gflow-cli lock provenance

These two files are copied verbatim from upstream tag `v0.82.1` of
`ffroliva/gflow-cli`:

- `pyproject.toml`
- `uv.lock`

They are build metadata only; the gflow source itself is still installed from the PyPI wheel.

The Flow worker uses this upstream lock to export the runtime dependency closure with
`uv export --frozen --no-dev --no-emit-project`. The resulting requirements include hashes, so a
worker rebuild cannot silently resolve newer transitive versions than the ones upstream tested.

When bumping gflow:
1. update both files from the exact upstream release tag;
2. update the pinned gflow wheel version/hash in the worker Dockerfile;
3. intentionally review any lockfile diff;
4. run the worker unit tests and image-build CI;
5. live-smoke one Flow image generation before production rollout.
