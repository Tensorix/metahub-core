**Present:** Noah, Mira, Kai

## Highlights

- Inline-mark editor shipped 🎉 — cursor-jump bug is structurally gone now that every block is its own CodeMirror instance.
- Offline PWA replica is in review; hydration-while-online path works end to end.

## Decisions

1. Hosted sites stay **same-origin** — we document the trust model rather than sandboxing per-site for now.
2. S3 backend is a *dumb store*: no server-side logic, sync stays client-driven.
3. Ship desktop auto-update after the PWA replica lands, not before.

## Action items

- [ ] Mira: finish OPFS eviction handling on iOS
- [ ] Kai: wire CORS auto-config for the S3 bucket
- [x] Noah: write architecture overview doc
- [ ] Noah: README hero + screenshots

## Open questions

Do we expose a per-site credential so a published page can be *read-only*? Parked until after launch — see the architecture overview for the current trust boundary.
