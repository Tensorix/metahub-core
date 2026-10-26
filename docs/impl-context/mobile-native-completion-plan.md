# Expo mobile remaining implementation plan

Approved 2026-10-26. Worktree: `/Users/noah/Work/Tensorix/metahub-core.feat-mobile`, branch `feat/mobile`. Original baseline cbb58d9; clean rebase onto origin/dev d7a524b produced 2d805f5. Prior 240 passing tests and partial native evidence are baselines, not full acceptance.

## Scope and architecture

Native UI is P0: official Expo UI skills, SDK 57 docs and installed types; universal @expo/ui renders SwiftUI/Compose, platform components only when needed. Expo Router owns navigation. Short forms use native grouped rows; unknown-size data stays virtualized. Keep packaged WebView/CM6 body editor, SQLite replica, CRDT, server and encrypted bucket protocols. Credentials never enter WebView. Deliver installable Release builds, no store publication. Exclude field conversions, database/field/option deletion, full native calendar/timeline. Preserve whole-meta.views LWW and unknown config.

## Independent implementation and native acceptance ledger

| ID | Work | Implementation | Native acceptance |
|---|---|---|---|
| R00 | Preserve work; fetch/rebase dev; dependency compatibility; CNG builds, ordinary launch/logs | SDK 57 patches, CNG dual Release builds and normal installs complete | iOS normal launch; Android server connection/home/record/doc observed |
| R01 | Shared Host, native fields/menu/status, sizing/safe area/theme, Material You, native/RN interop | native Host/forms/buttons/menus/sheets/FAB implemented; Android text-label defect corrected | theme/accessibility/large-font matrix pending; corrected labels need final build retest |
| R02 | Native tabs investigation; iOS toolbar actions, Android Compose FAB; native sheets/forms; navigation context | Router serialized toolbars replace crashing Host headers; nested home stack; guarded form exits | iOS/Android record open no longer crashed in provisional retest; iOS 27 tabs fallback remains; complete return/gesture/deep-link matrix pending |
| R03 | Preserve native input, revisioned drafts, ordered saves, late-ack isolation; common exit flush; success-only deletion | session handoff, draft receipts, frozen flush, deletion and form write guards implemented and regression-tested | Android record-to-document/save observed; latest exit/reauth changes await native retest |
| R04 | Paged home documents and global search, stable ordering, stale query isolation, four loading states | paged home/global search, deterministic results and tail-page recovery implemented | large multi-page bilingual UI traversal pending |
| R05 | Separate reference open/select, flush before navigation, titles across pages, searchable relation configuration | independent open/select, reference summaries and save-before-navigation implemented | Android linked document open and edit saved to test server; complete return/cross-page validation pending |
| R06 | Document create/child/rename/copy/move/root/delete/history/restore and workspace-local recents | document management/history/recents and successful-delete-only draft cleanup implemented | management round-trip/restart matrix pending |
| R07 | Native database/field/option/view management; field order hardening; option order; preserve config and cell values | native DB/field/option/view forms and guarded edits implemented; unknown-config preservation reviewed | cancel/failure/config-sync UI acceptance pending |
| R08 | Board cross-column moves, manual record ordering including page edges, column order | manual record/column order and same-column cross-page anchors implemented and tested | native board ordering and concurrent-anchor cases pending |
| R09 | Cached hash verification, retry reports, pending repair, transfer journal, orphan reconciliation and protected cleanup | hash validation, retry outcomes, pending repair, journal/orphan accounting and cleanup protections implemented | attachment import/upload/download/preview/share/restart chain pending |
| R10 | Native settings/server/bucket/enrollment/recovery, separate save/sync/attachment status, authorization recovery | native settings/enrollment/reauth and separate save/data/media status implemented; stable-session handoff reviewed | prior iOS reauth blank reproduced; fix tested in code, native retest pending |
| R11 | Convergence/fault/network stress tools and performance fixes without breaking atomic CRDT writes | real HTTP stress, SQLite fault fixtures and ingest/index/query optimizations implemented | provisional iOS Release 20,012 network ops passed; 10k/1k search P95 3.97ms; first-page 206ms failed target and fixed in source; final dual-platform measurements pending |
| R12 | Mobile CI, reproducible builds, final review, sanitized evidence, commits and push | CI and source-fingerprinted build helper implemented; parent organizing reviewed commits | fixed final candidates, four workflow cells, final push and evidence still pending |

## Required behavior per package

- R00: SDK 57 patch checks only, no major upgrade by default. Rebuild both platforms after native dependencies change. Record device/OS/build/commit, separate normal UI from diagnostics. Preserve existing native evidence.
- R01: use current theme preferences consistently in RN/native hosts/editor. Native observable text state is not a string-controlled RN input. Verify actual APIs: installed 57.0.26 has no universal Menu. Platform files belong outside route tree. Large data lists remain FlashList/FlatList.
- R02: retain working iOS27 JS-tabs fallback until native tabs work in Release. Use iOS navigation/toolbars, Android Material actions; eliminate fixed bottom clearance. Small selectors use BottomSheet, complex save/cancel forms use route presentations. Preserve query/view/page/selection/scroll on return; isolate by workspace.
- R03: remote refresh cannot overwrite dirty inputs; old receipts cannot clear newer drafts. Back/swipe/dismiss/blur/Done share save coordination. Failures keep drafts and actionable retries. Switch isolates late callbacks without deleting local workspace. First prove record -> reference -> document -> return on both platforms.
- R04: querySearch supports more than 50 results; home pages documents. Filter/search/sort apply to complete result set. Stable ties, limit+1 sentinel and consistent FTS/LIKE choice. Reset on query/workspace changes and invalidate changed data safely. Loading/empty/error/retry/more must be truthful.
- R05: opening a related item is independent of selection editing and follows successful flush. Resolve selected titles by IDs even outside current candidate page; missing targets remain recognizable. Pick databases/records through searchable selectors, no manual ID entry.
- R06: reuse core document commands. Flush before copying/moving; version guard history restore. Freeze editor on delete, discard recovery draft only on success, recover after failure. Explain that deleting a parent promotes children to roots. Recents are local and workspace-scoped.
- R07: preserve cancel/save semantics, errors keep forms open. Field ordering already exists and needs regression/hardening. Option renames update cells through shared command; option order only changes ordering. Preserve unknown views/layouts/config.
- R08: explicit up/down/target controls, no drag requirement. Manual record order requires no sort/filter/search; explain disabled state. Column moves remain available. Use record anchors across pages, never rebuild database ordering from one page.
- R09: verify cache content size/hash. Downloaded corruption can refetch; pending corruption remains protected and needs matching-hash reselection. New content requires explicit new reference. Expose per-entry failures and uploaded/failed/pending counts. Journal persistence before rename; reconcile interrupted operations, account/quarantine unknown canonical files, remove only abandoned transfer files. Never evict pending/pinned/active bytes.
- R10: distinguish durable local save from data sync and media failure. Preserve offline use after authorization expires, enrollment/recovery, reconnect, initialization resume and per-workspace node/database isolation. No credential logging.
- R11: exercise offline forks/replay/concurrent edit/delete races/interrupted sync, hydration, migration/disk full/corrupt media. Optimize measured ingest/index/paging stalls. No await inside CRDT write transactions.
- R12: Bun tests, editor build, typecheck/lint, browser/SDK regression. Add mobile CI and native build artifacts. Parent reviews and owns commits/push; fetch dev again before final submission.

## Shared contracts

Add querySearch(text,{offset,limit}) -> {hits,offset,limit,hasMore}, retaining search(text,limit). Add batched referenceSummaries({kind,databaseId?,ids}); shared moveProperty/moveSelectOption commands reread current config and validate anchors. Existing moveRecord stays canonical. Attachments add observable status and retry {uploaded,failed,pending}; recovery journal is local metadata. Add drafts.discardDocument only for explicit successful deletion. Local schema changes must migrate and recover safely.

## Parallel ownership and review

Maximum three subagents, gpt-6.1-sol. Parent freezes contracts/file ownership, handles dependencies/builds/devices/integration/final review/commits.

1. Foundation: native Host/navigation/input HIGH; shared query/order/reference APIs HIGH; attachment integrity/recovery HIGH.
2. Pages after contract review: record/reference/history/doc HIGH; home/search/database/views/board MEDIUM; settings/connection/sync/media UI MEDIUM.
3. Verification preparation: editor/IME/process recovery HIGH; sync/fault/performance HIGH; CI/builds/checklists MEDIUM.
4. Acceptance: iOS scripted cases LOW; Android scripted cases LOW; regression/evidence LOW. Complex failures return to medium/high implementation owners.

One writer per file and one operator per device. No agent commits/pushes or changes dependencies independently. Review completed contracts before dependents start. Device builds/installs/Metro scheduled by parent. Reports include changed behavior, tests, unverified gates and limitations; no converting failures into passes.

## Acceptance and deliverables

Four cells: iOS/server, iOS/bucket, Android/server, Android/bucket. Each must cover connect -> hydrate -> airplane cold start -> browse/search -> create/edit record -> board -> related document edit -> attachment -> kill/restart -> reconnect -> desktop convergence -> desktop edit back to phone. Check IME/unblurred text/back swipe/WebView recreation/foreground/background/reauth/workspace switch, long text, accessibility and large fonts.

Use local simulators first, Release with no Metro. Physical device evidence is separate. Normal round-trip testing uses uniquely named synthetic records/media and hashes. Faults and bulk loads use independent replicas and test bucket/prefix; never mutate user's envelope or damage existing data. Keep credentials/invitations/raw private content outside Git; commit sanitized results only.

Performance: 10,000 records, 1,000 docs, >=20,000 queued operations transported through network (not service-seeding substitute). Target search p95 <=300ms, non-migration cold launch to interactive home <=2s, avoid >100ms JS batches in sync/index/paging. Fixed Release build, record device/OS/sample counts and measurement boundaries. Physical-device performance is an independent gate.

Deliver Android installable package, iOS simulator Release app, physical iOS installation build when provisioning permits, build reproduction, commit SHA, tests and known limitations. Missing device/provisioning/test storage stays explicit external dependency. Core workflow is complete only when all four cells have native evidence; unresolved platform fallback/performance prevents stable daily-use completion.

## Execution log

- 2026-10-26: fetched origin; local and remote feat/mobile were identical. Rebased cleanly onto d7a524b. Started three foundation agents with exclusive file ownership; no new native acceptance claimed.

- 2026-10-26 foundation review: shared query/order/reference contracts passed 93 regression tests; attachments passed 27 tests after correcting pre-adoption recovery and pending/pinned protection. Mobile tests plus CI scope: 91 pass, 0 fail (343 assertions). Page-only checks are not native acceptance.
- SDK remains 57; patch set includes @expo/ui 57.0.26 / expo-router 57.0.29. CNG iOS Release and Android arm64 Release built and installed. Provisional source was changing during builds, so these are environment/sample artifacts, not a fixed final candidate. iOS 27 device 50231799-2BC1-4440-BEA8-D0F4F8EE40C0 and iOS 26.5 device 65800692-463E-4CAB-95E8-F4234DA4AF05; Android Pixel_9_Pro emulator-5554.
- Native sample found a real iOS record-open SIGSEGV in Fabric header layout with SwiftUI DisplayList insertion (2026-10-26 11:41). Replaced Host-backed custom header actions with official Router Stack.Toolbar serialization on iOS; Android uses Router's supported Compose toolbar implementation. Rebuild/retest required. Same-workspace reauthorization also produced a blank screen until restart; stable-stack/session handoff fix under review. These failures remain open.
- Disposable server at loopback port 8991, isolated temporary METAHUB_HOME, synthetic record/document fixture. New localhost workspace initial download succeeds. Existing user bucket data was only observed and retained. No destructive fault or large-load test used the user bucket.

- Review checkpoint: Android normal Release connected to isolated server, opened record and linked document without crash, and saved document text confirmed independently through the server API. Return UI was blocked by CUA window errors; no full workflow claim. Some Android native buttons displayed no text: corrected raw string children to native label props; final retest required. See mobile-android-ui-20261026.md.
- iOS provisional embedded Release synthetic tests transported 20,012 unique ops with cursor/replay/authorization checks passing. Search on 10,000 records + 1,000 documents P95 was 3.97ms (20 warm queries); first page 206ms/observed timer gap 204ms failed the batch target. Moved derived index creation from read query into schema initialization; old databases pay one-time migration cost. Baseline JSON is retained under mobile-evidence/20261026, explicitly marked provisional.
- Main-agent review found and corrected stale view opaque-key overwrites, same-column ordering anchors, empty tail pages, form pending/close races, editor navigation freeze, delete-after-failed-save and late form receipts. SQLite FULL fault injection additionally exposed automatic rollback errors; final native fault results remain pending.
