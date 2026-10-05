# Google Flow Try-on Provider — Implementation Plan

Contract: [`docs/specs/storefront-virtual-try-on-flow-amendment.md`](../docs/specs/storefront-virtual-try-on-flow-amendment.md).

1. **Contract tests first**
   - provider config: feature-off, Vertex compatibility, Flow URL/token validation;
   - Flow client: authenticated private request, bounded/validated output, safe error mapping;
   - fallback classifier: Pro daily-quota exhaustion only.
2. **Storefront provider adapter**
   - add provider-aware server config;
   - add `google-flow-try-on/client.ts`;
   - dispatch from existing `try-on-runtime.ts` without changing UI/endpoint/domain gates;
   - retain Vertex as manual rollback.
3. **Private Flow worker**
   - pin `gflow-cli==0.82.1`;
   - real Google Chrome, headed under Xvfb for normal runs;
   - persistent `GFLOW_CLI_HOME` volume;
   - request-scoped temp files, fixed prompt, one image;
   - `nano-pro` primary; one `nano2` fallback only on daily quota exhaustion;
   - one in-flight request/profile; bearer auth; no sensitive logging.
4. **VPS wiring**
   - backend-only Compose service, no published port;
   - named profile volume;
   - server-only app/worker token and provider configuration;
   - healthcheck.
5. **Documentation / rollout**
   - document one-time operator login and rollback;
   - record privacy/history difference from Vertex;
   - keep kill switch off by default.
6. **Verification**
   - CI: lint, typecheck, domain/integration tests, build, worker stdlib tests/compile;
   - live Flow checks remain pending until a signed-in Google profile is available.

Definition of Done follows the project shared references: acceptance criteria plus tests/build, focused
diff, security review, documentation, observability and rollback evidence.
