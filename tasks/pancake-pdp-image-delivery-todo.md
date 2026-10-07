# Pancake PDP image delivery checklist

- [ ] RED: add hard-cap / width / bounded-retry domain tests.
- [ ] RED: add trusted fetch/transcode integration tests.
- [ ] GREEN: add explicit `sharp@0.35.4` production dependency.
- [ ] GREEN: implement pure delivery policy and bounded compression schedule.
- [ ] GREEN: implement trusted Pancake fetch + Sharp WebP transcode.
- [ ] GREEN: bind `GET /api/product-image` on Node runtime.
- [ ] GREEN: wire PDP gallery/stage through the custom loader.
- [ ] VERIFY: focused tests.
- [ ] VERIFY: `pnpm lint`.
- [ ] VERIFY: `pnpm typecheck`.
- [ ] VERIFY: `pnpm test`.
- [ ] VERIFY: `pnpm build`.
- [ ] REVIEW: correctness/security/architecture/simplicity/performance; 0 Critical / 0 Required before merge.
