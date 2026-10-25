# Mobile native acceptance record

Recorded 2026-10-25 against `feat/mobile`, baseline `c6e4ecd`, shared-core commit `42d4ea7` and mobile implementation commit `8fdd98e`. This is a partial acceptance record. T19 remains open. Build success and diagnostic success do not establish the full daily-use workflow.

## Native build and compatibility evidence

- Android arm64 debug build and emulator diagnostic launch succeeded.
- iOS CNG build and simulator diagnostic launch succeeded with Xcode 27. The scene initialization fix is expressed in Expo configuration: Expo `~57.0.31`, expo-build-properties `~57.0.22`, `ios.enableSceneSupport: true`. Generated native files are not the source of that fix.
- Both native platforms initially reported 18 PASS diagnostic assertions: driver null/bind/change semantics, blobs, transaction rollback/savepoints, schema probing, CRUD, durable editor checkpoint and reopen, three FTS close/reopen cycles, Bun-generated encrypted payload decoding, native crypto round-trip and wrong-passphrase rejection.
- Native-generated ciphertext was independently verified with Bun using `scripts/verify-native-crypto.ts` (PBKDF2 envelope, AES-GCM and encrypted gzip). The diagnostic fixtures contain synthetic public test content, not credentials.
- The native SQLite connection sets `finalizeUnusedStatementsBeforeClosing: false` to avoid the FTS close/reopen double-free seen with the automatic finalizer. The repeated close/reopen assertion exercises this correction.

Android and iOS final diagnostics each report 20 PASS assertions, adding real HTTP pairing, offline writes with close/reopen, bounded upload to a disposable Bun server, desktop API edits and pull back into the native replica. These are native transport checks, not the full native UI workflow. The iOS result was also confirmed through accessibility inspection.

Evidence files:

| File | Scope |
| --- | --- |
| [Android diagnostics](mobile-evidence/android-debug-native-diagnostics.json) | Emulator debug native driver and crypto assertions |
| [iOS diagnostics](mobile-evidence/ios-debug-native-diagnostics.json) | Simulator debug native driver and crypto assertions |
| [iOS final diagnostics](mobile-evidence/ios-debug-native-diagnostics-final.json) | 20 PASS, including real HTTP server transport |
| [Android final diagnostics](mobile-evidence/android-debug-native-diagnostics-final.json) | 20 PASS, including real HTTP server transport |
| [Android final performance](mobile-evidence/android-debug-performance-final.json) | Indexed default paging and search batch size 25; debug emulator measurements |
| [iOS measured performance](mobile-evidence/ios-debug-performance-measured-mixed-hmr.json) | Mixed HMR run; not a controlled final comparison |
| [Android performance before query optimization](mobile-evidence/android-debug-performance-before-query-optimization.json) | Baseline only; superseded query implementation must be measured again |

## Reproduction

Use Bun for JavaScript commands. From repository root:

```sh
bun install
cd apps/mobile
bun install
bun run build:editor
bun run typecheck
bun run lint
```

Generate native projects through Expo CNG and build on the matching host toolchain:

```sh
bunx expo prebuild
bun run ios
bun run android
```

Run the opt-in diagnostic surface in a development native build, with a fresh Metro process so its public environment flags are embedded:

```sh
EXPO_PUBLIC_MH_SELFTEST=1 bun run start --clear
```

For performance, use `EXPO_PUBLIC_MH_SELFTEST=1 EXPO_PUBLIC_MH_PERF=1 bun run start --clear`. Launch/reload the native development app and wait for all phases. The diagnostics write `native-diagnostics.json` and performance writes `native-performance.json` in the app document directory. These flags replace the ordinary UI with diagnostics only in development; use a new Metro process without these flags for workflow acceptance.

For an Android debug emulator, retrieve reports with:

```sh
adb shell run-as com.tensorix.metahub cat files/native-diagnostics.json > /tmp/metahub-android-native-diagnostics.json
adb shell run-as com.tensorix.metahub cat files/native-performance.json > /tmp/metahub-android-native-performance.json
```

For iOS, resolve the installed simulator container using `xcrun simctl get_app_container booted com.tensorix.metahub data`, then copy `Documents/native-diagnostics.json` and `Documents/native-performance.json` from that returned directory. Confirm the diagnostic results contain no FAIL entries and all expected phases completed; do not infer success from report existence alone.

From `apps/mobile`, verify each retrieved diagnostic report independently:

```sh
bun scripts/verify-native-crypto.ts /tmp/metahub-android-native-diagnostics.json
bun scripts/verify-native-crypto.ts /tmp/metahub-ios-native-diagnostics.json
```

Start the disposable synthetic HTTP fixture from repository root with `bun apps/mobile/scripts/native-acceptance-server.ts`. Native HTTP transport checks use `EXPO_PUBLIC_MH_TRANSPORT=1` in addition to the self-test flag, with the fixture service reachable at device loopback port 8991 (Android requires `adb reverse tcp:8991 tcp:8991`). Android and iOS final evidence cover this path; these checks do not constitute acceptance against a real S3 service.

## Performance interpretation

The recorded Android baseline used Hermes, a debug development Metro bundle and an emulator; 10,000 records, 1,000 documents, batch size 10, and 49,007 generated operations. Warm search p95 was 4.64 ms. Paged queries took 2,943 ms for the first page and 902 ms p95; this baseline predates indexed default-page optimization.

The report's `status: PASS` means the harness completed. It does not mean production performance thresholds passed. Observed timer gaps were 762 ms during ingest, 518 ms during indexing and 575 ms during paging, exceeding the 100 ms responsiveness target. SQLite reopen plus home data queries took 15.85 ms, but excludes process startup, React rendering and navigation and cannot establish a <=2 s cold home launch. No actual-device release performance pass is claimed.

The final Android run with indexed default paging and search batches of 25 measured warm search p95 2.99 ms, all 50 pages in 993 ms, first page 119 ms and page p95 30.5 ms. SQLite reopen/home queries measured 13.61 ms. Timer gaps still exceeded 100 ms (ingest 1,195 ms, indexing 1,541 ms, paging 114 ms), so responsiveness remains open. The fixture seeds service writes; it does not measure network ingest of a 20,000-operation backlog.

The iOS measured run reported warm search p95 2.405 ms, 50 pages in 1,091 ms, first page 254 ms and SQLite reopen/home queries 8.056 ms. Its old `status: PASS` label refers only to functional completion. HMR mixed code during measurement, so this report is observational evidence and cannot be used as a controlled final comparison. Timer gaps also exceeded 100 ms.

## Outstanding acceptance gates

Run the following on both iOS and Android, separately for server sync and direct encrypted bucket sync:

1. Connect and hydrate; cold-launch in airplane mode; browse and search local data.
2. Create/edit a record, move a board card, edit a linked document, attach media, then kill/restart and verify durable local state.
3. Reconnect and establish desktop convergence; edit on desktop and verify the change returns to mobile.
4. Exercise IME composition/selection, keyboard/safe areas and back-swipe/navigation flushing; document picker, image picker, sharing and previews; WebView termination/recreation.
5. Kill the process before acknowledgment and verify durable checkpoint recovery; exercise stale acknowledgments, workspace changes during sync, interrupted migration/hydration, credential revocation, disk-full and corrupt/missing blobs.
6. Validate real S3-compatible service signing, pagination, object uploads/downloads and failure recovery. Synthetic HTTP transport checks alone cannot close this gate.
7. Measure actual-device normal cold home <=2 s, search p95 <=300 ms and bounded ingest avoiding >100 ms JS stalls with the required large fixture and >=20,000 queued operations. Record device, OS, build mode, fixture and measurement scope.

Implementation and Bun tests cover portions of these behaviors, but native full-workflow and failure-injection evidence is still required. The final reported Bun regression run passed 227 tests across 26 files with 2,824 assertions and 0 failures (`/tmp/metahub-mobile-final-checks.log`). Earlier editor-only evidence was 48 passing tests. Final mobile `bun run typecheck` and `bun run lint` both passed without errors or warnings. The browser shell build also passed. The separate i18n suite has 4 passes and 1 failure from 29 existing unused sharing translations; no missing translations were reported. The regression invocation from repository root was:

```sh
bun test apps/mobile/src/lib src/core/replica src/shared/views src/core/crdt.test.ts src/core/schema-init.test.ts src/core/sync/client.test.ts src/core/sync/storage.test.ts src/core/sync/storage-s3-fetch.test.ts src/core/sync/e2ee.test.ts src/core/sync/enroll.test.ts src/core/search.test.ts src/webui/view-model.test.ts src/webui/data/api-map.test.ts src/webui/document-save.test.ts src/sdk/client.test.ts src/sdk/drop.test.ts
```
 Parent review completed and implementation commits were created. Latest `origin/dev` (`1899618`) was fetched again before commit and is already an ancestor; no further rebase was needed.

Android manual UI acceptance is currently blocked by the available computer-use tool being unable to attach to the unbundled emulator. iOS manual UI verification is partial; after the checks below, DeviceHub computer-use reads became stuck on its Device menu and stopped returning screenshots. Final deep-link opening and record-close UI checks remain unverified. Neither limitation closes a gate.

## Additional iOS UI evidence

On iPhone 18 Pro / iOS 27 simulator with the signed debug build, CUA exercised onboarding against the disposable HTTP server, opening and editing a document in the packaged editor, returning to save, and creating a record. Server API reads verified the document title/body and record value. With the server process suspended, killing/relaunching the app still allowed opening local documents and saving an appended line. A second restart and a read-only SQLite check confirmed that line persisted; after the server resumed, its API returned the same updated body. See [partial UI observations](mobile-evidence/ios-ui-partial-workflow.json).

This used a development bundle. Server unavailability is not airplane-mode cold launch, and this does not close the release cold-start gate. A signed standalone iOS Release simulator build succeeded and was installed/launched, but its complete UI workflow has not been verified. The explicit record close button and navigation flush have 17 focused unit tests; their final native interaction remains pending. Debug signing must retain simulator keychain entitlements for SecureStore; the earlier unsigned build could run driver diagnostics but could not run the normal theme/session UI.

## Existing bucket enrollment

The existing enabled local S3 configuration was read without modification. A private QR/link artifact was generated outside Git using the shared access-only enrollment codec. Native links use `metahub://connect?enroll=…`; both this query form and existing web fragment links are recognized by mobile scanning. The public connection route works independently of whether a workspace is already configured. Desktop Add Device offers App and browser/PWA targets.

The shared fetch/SigV4 adapter, running under Bun, successfully read the real bucket key envelope and verified the locally stored master key by decrypting existing ciphertext. This probe was read-only and is not a native upload/download acceptance pass. The enrollment link deliberately excludes the passphrase and master key. The user must enter the existing encryption passphrase in the mobile App before the real workspace can connect; full native bucket sync remains pending. No access keys, master keys, enrollment tokens or real workspace data are included in this repository's evidence.

To generate a private invitation from an already configured hub, run from the repository root (the output directory must not exist):

```sh
bun apps/mobile/scripts/export-enrollment.ts /absolute/path/to/metahub.db /private/tmp/my-mobile-invitation
```

Open the output `index.html` locally or scan `enrollment.gif` with a phone that has the current Metahub App installed. If multiple enabled buckets exist, supply the desired peer URL as the third argument. The generated files contain access credentials and are intentionally excluded from commits.
