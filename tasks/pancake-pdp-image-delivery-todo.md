# Pancake PDP image delivery checklist

- [x] RED: add hard-cap / width / bounded-retry domain tests (CI typecheck failed before implementation as expected).
- [x] RED: add trusted fetch/transcode integration tests.
- [x] GREEN: add explicit `sharp@0.35.4` production dependency.
- [x] GREEN: implement pure delivery policy and bounded compression schedule.
- [x] GREEN: implement trusted Pancake fetch + Sharp WebP transcode.
- [x] GREEN: bind `GET /api/product-image` on Node runtime.
- [x] GREEN: wire PDP gallery/stage through the custom loader.
- [ ] VERIFY: focused tests.
- [ ] VERIFY: `pnpm lint`.
- [ ] VERIFY: `pnpm typecheck`.
- [ ] VERIFY: `pnpm test`.
- [ ] VERIFY: `pnpm build`.
- [ ] REVIEW: correctness/security/architecture/simplicity/performance; 0 Critical / 0 Required before merge.
