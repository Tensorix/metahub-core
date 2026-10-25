# Expo mobile stable daily-use implementation

Baseline: feat/mobile c6e4ecd; origin/dev 1899618 and local dev b6b3731 already included. Verified fetch on 2026-10-25. Existing 45-test reliability baseline is not native end-to-end acceptance.

## Architecture

Native expo-sqlite implements shared DbDriver; core CRDT/oplog remains the only durable sync queue. All daily UI and packaged CM6 editor use one replica. Reuse server /sync and existing encrypted S3 format. Native credentials stay out of WebView. Attachments persist before references, on-demand cache with explicit pin/download. iOS first, both platforms required.

## Implementation tracking

Checked items mean implementation is present, not that every native acceptance gate has passed. Native evidence and outstanding gates are tracked in [mobile-native-acceptance.md](mobile-native-acceptance.md). Status recorded 2026-10-25; parent review completed; shared core `42d4ea7` and mobile implementation `8fdd98e` committed. Native acceptance remains partial.

- [ ] T01 Native builds/install and diagnostic launch verified on both platforms; actual-device cold start acceptance pending
- [x] T02 Typed replica/runtime/editor contracts and regression baseline — implementation present; acceptance limits below
- [x] T03 SQLite driver, nested transactions, migrations, isolated workspaces — implementation present; acceptance limits below
- [x] T04 Native crypto, gzip, SigV4 and cross-runtime compatibility — implementation present; acceptance limits below
- [x] T05 Extract shared command service and preserve browser behavior — implementation present; acceptance limits below
- [x] T06 Workspace migration, hydration resume and lifecycle isolation — implementation present; acceptance limits below
- [x] T07 Server pairing, bounded synchronization, durable cursors — implementation present; acceptance limits below
- [x] T08 Direct encrypted bucket enrollment and synchronization — implementation present; acceptance limits below
- [x] T09 Local-save versus sync status, retries and reauthorization — implementation present; acceptance limits below
- [x] T10 Local home/records/fields/relations/board/history — implementation present; acceptance limits below
- [x] T11 Paged local queries and incremental search indexing — implementation present; acceptance limits below
- [x] T12 Pure shared view definitions and query semantics — implementation present; acceptance limits below
- [x] T13 Light database/field/option management — implementation present; acceptance limits below
- [x] T14 Packaged offline editor and validated bridge — implementation present; acceptance limits below
- [x] T15 Durable revisioned checkpoints and navigation flush — implementation present; acceptance limits below
- [x] T16 Durable blobs, download pinning, upload recovery and preview — implementation present; acceptance limits below
- [x] T17 Keyboard/safe-area/back/selection/error mobile flows — implementation present; acceptance limits below
- [x] T18 Multi-replica convergence and failure recovery — implementation present; acceptance limits below
- [ ] T19 iOS/Android full daily workflow and actual-device performance acceptance (partial native evidence only)
- [x] T20 Parent review, shared-core/mobile implementation commits, latest dev ancestry check and explicit acceptance limitations recorded

## Ownership

Parent: integration/session/UI/dependencies/builds/final review and commits.
replica_implementation (gpt-6.1-sol high): core/replica and mobile/lib/replica.
sync_implementation (gpt-6.1-sol high): bounded HTTP sync, shared fetch S3, codec/native sync adapters.
editor_implementation (gpt-6.1-sol high): offline editor bundle, bridge and checkpoint coordination.
Later UI work medium; prescribed validation/docs low. Maximum three subagents.

## Acceptance

Both server and bucket: connect -> hydrate -> airplane cold launch -> browse/search -> create/edit record -> board move -> linked doc edit -> attachment -> kill/restart -> reconnect -> desktop convergence -> desktop edit back to mobile.

Run Bun regression tests, mobile typecheck and lint. Real native SQLite contract and builds required. Test stale acknowledgments, workspace switch during sync, revoked credentials, disk-full, corrupt blobs, interrupted migrations/hydration and multi-peer races. Benchmark 10k records, 1k documents, 20k queued ops: search p95 <=300ms, normal cold home <=2s, bounded ingest batches avoiding >100ms JS stalls. Record actual device/build/fixture. No native success claim without evidence.

## Defaults

Existing CRDT and whole-meta.views LWW semantics retained. No field type conversion, database/field/option deletion, native calendar/timeline or publishing administration this phase. Existing remote workspace requires initial network hydration. Only downloaded media is offline available. Connection removal does not delete local data. Native app is not an automatic bucket snapshot publisher/garbage collector.

## Remaining execution gates

- [x] Join the existing real bucket on the iOS simulator through the native invitation and recovery-code UI; verify initial hydration, content equality with desktop and Release restart persistence. The generated QR/link remains private and outside Git.
- [ ] Verify offline edits and bidirectional business-data/attachment convergence against the real bucket.
- [x] Verify native invitation opening and usable Home/Search/Settings tabs on iOS 27; DeviceHub UI access recovered.
- [ ] Verify final record close/back flush in native UI.
- [ ] Complete native board, relation, attachment, preview and process-kill workflows on both platforms; restore Android UI automation access.
- [ ] Run release airplane-mode cold launch and real-device performance measurements.
- [ ] Diagnose remaining >100ms timer gaps and measure network ingest of at least 20,000 queued operations.
- [ ] Complete native fault injection (revocation, migration/disk-full, corrupt blobs and interrupted hydration).
