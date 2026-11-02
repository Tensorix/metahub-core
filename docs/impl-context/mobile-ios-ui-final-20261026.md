# iOS ordinary Release native acceptance — 2026-10-26

Historical raw-evidence availability (checked 2026-10-28): the 20261026 temporary raw screenshots, hierarchies, device logs and fixture files are no longer available. Any /tmp paths below are historical locators only, not currently accessible evidence. Only the sanitized reports, JSON summaries and reviewed synthetic screenshots in this repository remain for review; historical runs cannot be independently replayed or re-audited from those missing raw files. Recorded failures and acceptance limits remain unchanged.

Status: IN PROGRESS. This does not mark the iOS/server or iOS/bucket complete workflow as passed.

## Environment

- iPhone 18 Pro simulator, iOS 27.0, device 50231799-2BC1-4440-BEA8-D0F4F8EE40C0.
- Ordinary Release, no Metro; initial candidate ea130b8, then 7d07c80 and 6db2a4a. All five diagnostic flags explicitly disabled.
- Maestro 2.11.0 with analytics disabled, after explicit user authorization to use native UI automation. Native screenshots/hierarchies were historically captured under /tmp/metahub-ios-ui and are now unavailable; only synthetic fixture evidence may be committed.
- Disposable loopback server on port 8991, separate local data directory. Existing user databases and remote envelope were not modified.
- 7d07c80 simulator ZIP SHA256: 35881d3c1851013bcfd2735f17e743260c22207410555a257bbc4b5dcdbaae35. Local artifact apps/mobile/dist/native/7d07c80/manifest.json records both platforms and toolchain.

## Observations and verified results

| Case | Result | Evidence / boundary |
|---|---|---|
| Existing record edit, open linked document without prior blur, return | Observed saved title on server and return to record; full repeat still pending | Earlier CUA actions were unstable and are not a complete Maestro run |
| Native Back, record Close, Home and New menu | PASS | home-new.yaml |
| Create document form on ea130b8 | FAIL: blank input region | Native scrolling FieldGroup was measured inside an unbounded outer scroller |
| Create document on 7d07c80 | PASS | create-fixed.yaml: input title, Save, editor title assertion; no API shortcut used for this created document |
| Select synthetic PNG in Photos, insert and save | PASS | photo-select.yaml; saved document body includes a blob reference; independent server GET returned identical SHA256 and 67 bytes |
| PNG byte integrity | PASS | SHA256 12e212c5a097e3d6281e144097a4b76c358a360cd453dee335e2b01a12d923e2, matching original synthetic fixture |
| Rename initial automation attempt | Script assertion FAIL | eraseText deletes before cursor; tapping middle left old suffix. Visible/native title and saved value agreed. Retesting with full-field replacement; not called an app failure |
| Rename / copy / child | PASS on 7d07c80 | manage-fixed.yaml; exact renamed title iOS Renamed, copied document and child independently observed |
| Delete parent and promote child | PASS on 7d07c80 | delete-parent.yaml; confirmation explains promotion; server confirms deleted copy absent and child parent_id null |
| History view / restore | PASS for child creation revision on 7d07c80 | history-open / history-restore / history-restore-delete; not an older-body conflict test |
| Move / move to root | PARTIAL on 6db2a4a | target-label tap succeeds and server parent changes; row-center tap fails due intrinsic SwiftUI Button hit area. Fixed in d42685b; new native retest pending |
| New record / edit / unblur Close / reopen | PASS on 6db2a4a | new-record / record-edit; exact iOS Native Record persists. Later document-field assertion used wrong fixture database and is not an app defect |
| Reference picker while keyboard visible | FAIL on 6db2a4a | search opens, but Done is clipped under status bar and selection assertion was absent from earlier command-only script. d42685b correction requires native retest |
| Attachment preview, sharing, offline cached rendering | Pending | Upload evidence alone is insufficient |
| Offline cold start and record edit | PASS on 6db2a4a | disposable server SIGSTOP; cached Home/record remains usable and title edited to iOS Offline Saved |
| Offline linked document / unblur exit / process restart | PASS on 6db2a4a | offline-document-open / offline-body-restart; iOSOfflineBody20261026 persisted after stopApp/launchApp and reopening |
| Reconnect and phone changes on desktop | PASS on 6db2a4a | resumed same server process; independent server API confirms record title and document marker, local server-offline-roundtrip.json |
| Desktop document change back to iOS | PASS on 6db2a4a | API append iOSDesktopReturn20261026, native Settings manual sync and reopen assertion in desktop-return-v2.yaml. First script used outdated button text and failed; retained separately |
| Bucket enrollment and complete ordinary workflow | Pending | Isolated fresh-key child-prefix fixture ready |

## Remaining gates

Four platform × transport cells, complete failure/retry and keyboard/gesture/accessibility coverage, app cold-start measurements and physical-device performance remain open. Installed 6db2a4a retains the documented JS-tabs fallback. Separate flat and nested NativeTabs fixtures pass on iOS 27; the real main application candidate still requires verification before removing the fallback. These limitations prevent stable daily-use acceptance.

6db2a4a normal simulator ZIP SHA256: 38a1803cecd14d615ef1dfcc8f16217ecf8851993835462fc29d8bbd30dbc6fa. Full manifest retained in apps/mobile/dist/native/6db2a4a. Existing sample document history contains an earlier accidental private clipboard value, subsequently undone: raw history/screenshots of that revision must stay outside Git. Current synthetic-only evidence is reviewed separately.

## ff9374a fixed normal candidate

Both normal Release builds succeeded; source fingerprint remained 92f90bd8e0d5a73c528cf3eb1f3607759cc0bc454f732c490c1b2425b6e8597d (723 input paths) before/after compilation. Simulator ZIP SHA256 7f864190242e8661fa84a94faae69c85ba2bd92a0032d692bed58b51a95d57d4.

- NativeTabs main app: PASS cold launch, three native tab IDs and five Home/Search/Settings cycles; native screenshot visually confirms system glass bar/icons. This supersedes the installed 6db2a4a fallback observation; auth/workspace transition checks still remain.
- Reference selection/open/return: PASS with explicit selected count 1→2, Done closes, open selected target and Back returns. Independent server API confirms both IDs. The first script tapped the SwiftUI toggle label (not its switch) and failed; corrected interaction taps the actual switch. This run alone does not prove software-keyboard geometry, because the final screenshot has no keyboard.
- Form target-row center / save / root: PASS, including selected checkmark and independent server parent_id null. First script matched the search input instead of the same-named result row; index 1 targets the actual row. Original failed script is retained.
- Full Bun regression: v3 had 1954 pass / 3 skip / 2 loopback failures (room provisioning malformed HTTP, OAuth timeout). Targeted unchanged rerun 15/0 then full v4 1956 pass / 3 skip / 0 fail (10387 assertions, 203 files). No timeout or test assertions weakened; exact transient cause not established. Mobile typecheck/lint pass.

## ff9374a server and bucket follow-up

- Specified server record board move: PASS using the independent sibling menu and target-relative selector (`board-exact-move.yaml`); server record Status independently confirmed Todo. Earlier ambiguous/offscreen menu attempts are retained as script failures.
- Native server attachment download: cached file is 63 bytes with SHA256 f4ee41d8b4537bdc4f011d889dfde2d949fde90d5ab1eb0723ab3a4cac3685a3, matching the synthetic source. Actual system share sheet remained open >60 seconds, then cancel/edit/return/restart retained iOSShareAfterHoldFF9374a, independently confirmed on server. No external share recipient was selected.
- Isolated real bucket enrollment: invitation and password completed initial hydration; `bucket-home-confirm.yaml` confirms both synthetic databases, native Home tab and absence of old server content. Initial scripts tapped a static password label or used an exact row selector missing its emoji; these attempts are not passes. Connection form intrinsic-width overflow was observed and fixed in d3e94d3; native layout retest pending.
- Bucket record → related document → return → process restart: PASS (`bucket-record-open`, `bucket-edit-open-document`, `bucket-document-edit-restart`). Notes iOSBucketSaved20261026 was edited before directly opening the relation; body marker iOSBucketDocumentSaved20261026 survived return and stopApp/launchApp. Parent's independent persistent desktop replica verification passed for both values. This was online, not an offline bucket run.
- Remaining iOS bucket gates include offline cold start, attachment import/upload/download, board and desktop-to-phone changes. Search pagination, software keyboard/IME, gestures, accessibility and full failure/retry coverage remain open.

## 6d5c199 next normal candidate

Source 6d5c199da28e9b69f64cd2146a27b03fcb501c71; dual Release build succeeded, all diagnostic flags 0, no Metro. Source fingerprint before/after 4b7c599bb83107beaa6b2735e96a7bdbb904902c85854e7dcc1bf613be4cd659 over 734 paths (includes recorded untracked e2e fragments). Simulator ZIP SHA256 07b9778ba36d15a340f4dc4f0ee1fd3081a46db49c916102965d433112c0de09; embedded main.jsbundle c0be0effcf89fe9874a4a12d1ee172af34d1a3f34fbadae4174f7f33f4b7dd44. Installed preserving the isolated bucket workspace. Guarded-form exit and connection-width fixes are implemented; their native retests are in progress, not yet passes.

6d5c199 completed fragments:
- `guard-db-regression.yaml`: PASS, original dirty Close → Continue → Close → Discard returns safely; original name remains. Row Save → Close → reopen shows iOSDbSaved6d5c199, then Save restores exact original name. No native crash observed. Android independently passed the original discard-crash sequence, but a later rename/save run showed a new ANR; tracked separately, not waived.
- `bucket-board-move.yaml`: PASS specified iOS bucket record Todo→Done; independent desktop verify confirms Done with the prior Notes/body markers intact.
- `bucket-photo-open` + actual system picker screenshot + `bucket-photo-select`: PASS selecting the prepared synthetic PNG, save, return and process restart. Independent desktop reference + encrypted remote bytes verification confirms 95 encrypted bytes decrypt to 67 plaintext bytes, SHA256 12e212c5a097e3d6281e144097a4b76c358a360cd453dee335e2b01a12d923e2. Safe evidence: mobile-evidence/20261026/ios-bucket-attachment-remote-hash.json. First independent pull failed with unclassified storage/local error; retry succeeded, original failure log retained. This is not downloaded-cache/offline preview proof.
- `bucket-desktop-return.yaml`: PASS desktop Notes edit iOSDesktopReturn6d5c199 → bucket publish → native manual sync → exact record field assertion. Then native Search entered NativePage20261026 and displayed synthetic bilingual results. Dataset has 65 synthetic documents; full native pagination still being verified.

## Current acceptance boundary after 6d5c199

The earlier pending observations above are chronological, not current failures when a later candidate explicitly passed the same reproduction. The current normal candidate uses NativeTabs; the old JS fallback is no longer installed. All four complete workflow cells remain open.

- The isolated bilingual search fixture has 65 documents. The first-page results and tail 61–65 are accessible; opening document 65 and returning retains page 2. Changing the query resets to page 1. Two Next text-selector attempts did not change the page despite completed tap commands; the preserved coordinate retest did. A title-only assertion was corrected for accessibility's combined title/snippet label. No complete native ID-union proof or root cause for the selector behavior is claimed.
- A new record was created through the native database action, but its title is still empty; this fragment is PARTIAL, not successful named-record creation.
- Device Hub's Device → Keyboard → Toggle Software Keyboard displayed the real software keyboard. Initial typing showed English suggestions; Chinese composition was not established. Input was cleared. The host then locked, so composition, keyboard occlusion, large-font and screen-reader cases remain pending.
- Bucket offline cold start and cached attachment preview, connection-form width retest, view/field/option configuration, full gesture/failure recovery, app cold-launch measurement and physical-device checks remain open. Online bucket attachment integrity and desktop return evidence do not stand in for these cases.

Subsequent ordinary fa82bf0 native connection-width, theme and bucket round-trip verification is in [mobile-ios-fa82bf0-20261028.md](mobile-ios-fa82bf0-20261028.md). Earlier pending statements above describe their historical checkpoints.
