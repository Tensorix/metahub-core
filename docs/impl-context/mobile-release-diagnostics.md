# Synthetic native diagnostics in Release

These are separate benchmark artifacts. They do not exercise the normal application UI, establish native workflow acceptance, measure process cold launch to an interactive home screen, or establish physical-device performance. Keep the ordinary Release candidate installed for workflow QA except during an explicitly selected diagnostic run.

The root diagnostic branch does not mount `SessionProvider`, read saved connections, or open a user workspace. It uses in-memory SQLite and uniquely named `diagnostics-*`, `performance-*`, `transport-*`, and `network-stress-*` databases. Network stress talks only to the marked disposable loopback fixture on port 8992, verifies its marker, and cleans its sender/receiver databases. Do not point that fixture at a user hub or bucket.

## Compile-time selection

Debug diagnostics require `EXPO_PUBLIC_MH_SELFTEST=1`. Release diagnostics require **both** `EXPO_PUBLIC_MH_SELFTEST=1` and `EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE=1`. Add `EXPO_PUBLIC_MH_PERF=1` for 10,000 records / 1,000 documents and `EXPO_PUBLIC_MH_NETWORK_STRESS=1` for the separate ≥20,000-operation HTTP stress fixture. These public flags are bundled by Metro: changing the launch environment after installation does not change the selected mode.

Normal `apps/mobile/scripts/native-build.ts` candidates reject diagnostic selectors before creating output files or running CNG. Their manifests record `buildMode: application` and `artifactClass: normal-release-candidate`; subprocesses disable implicit Expo dotenv loading. Supply intended non-diagnostic configuration explicitly. Build diagnostic artifacts separately as below; never rename one to a normal candidate.

## Fixed Release recipe

Use a disposable checkout of one fixed commit with the matching Bun locks, editor bundle and CNG projects already prepared. Record the commit, dirty-source status, dependency versions, build command, SDK/toolchain versions, artifact SHA-256, device model/identifier, OS version, and run start/end times beside each result. Keep credentials and user content out of evidence.

From the repository root, start the isolated relay in a separate terminal:

```sh
bun scripts/replica-stress-server.ts
```

The loopback relay on port 8992 also provides authenticated `POST /fixture/reports` and `GET /fixture/reports` export. The POST route accepts only iOS/Android driver, network or performance reports classified `synthetic-native-diagnostics`, with a 128,000-character limit; GET returns the in-memory exports from that relay instance. Use the fixture authentication without copying credentials into committed evidence. This export is for synthetic reports only and requires no Android root access. Export keys are reused across runs: confirm source/artifact identity and completion timestamps before treating an export as a new result.

For Android emulator network stress, configure `adb reverse tcp:8992 tcp:8992` for the selected emulator. iOS Simulator can access host loopback directly. Do not enable `EXPO_PUBLIC_MH_TRANSPORT` unless the separate disposable transport fixture on port 8991 has also been deliberately prepared.

From `apps/mobile`, build iOS Simulator diagnostics:

```sh
NODE_ENV=production EXPO_NO_DOTENV=1 \
EXPO_PUBLIC_MH_SELFTEST=1 EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE=1 \
EXPO_PUBLIC_MH_NETWORK_STRESS=1 EXPO_PUBLIC_MH_PERF=1 \
xcodebuild -workspace ios/Metahub.xcworkspace -scheme Metahub \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath dist/native-diagnostics/ios/DerivedData \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES build
```

The diagnostic app is `dist/native-diagnostics/ios/DerivedData/Build/Products/Release-iphonesimulator/Metahub.app`. Install it only on the selected test simulator; label its archive `metahub-simulator-diagnostics-release`, and record its bundle hash.

From `apps/mobile/android`, build Android diagnostics:

```sh
NODE_ENV=production EXPO_NO_DOTENV=1 \
EXPO_PUBLIC_MH_SELFTEST=1 EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE=1 \
EXPO_PUBLIC_MH_NETWORK_STRESS=1 EXPO_PUBLIC_MH_PERF=1 \
./gradlew :app:assembleRelease --rerun-tasks --no-daemon --console=plain
```

Copy `android/app/build/outputs/apk/release/app-release.apk` to `dist/native-diagnostics/android/metahub-diagnostics-release.apk` (paths relative to `apps/mobile`) and record its SHA-256 before installation. `--rerun-tasks` ensures changed compile-time flags cannot reuse a prior normal bundle. Stop Metro during measurement.

## Results and boundaries

The diagnostic screen writes these files to the app's Documents directory. Extract them using the selected simulator/emulator's supported tooling, and save sanitized copies with platform, OS, artifact hash and run identifier in their names:

- `native-diagnostics.json`: driver/CRUD/reopen/crypto checks, build configuration, OS version and diagnostic classification.
- `native-performance.json`: fixture sizes, warm search sample count/timings, index steps, paged queries and database reopen timings. Service seeding is not network ingestion. Database reopen excludes app process startup, React rendering and navigation.
- `native-network-stress.json`: actual isolated HTTP upload/hydration, queue counts, replay/fault checks, bounded index steps and timer observations.

Reports distinguish `Debug` / development Metro from `Release` / embedded bundle, include measurement timestamps, platform/OS version and timer sample counts by phase. Record physical hardware identity externally; simulator results are simulator evidence. Timer gaps are observed event-loop samples, not a proof that every JS task stayed below a threshold. Functional `PASS` / `COMPLETE` is not a performance-target or native-UI acceptance claim. A fixed Release performance result requires the embedded Release classification and the matching immutable artifact/source record.

After extraction, stop the disposable relay, remove the reverse-port mapping if no longer needed, unset all diagnostic flags, rebuild the ordinary candidate with `bun apps/mobile/scripts/native-build.ts ios` or `android` from the repository root, and reinstall that normal artifact before continuing workflow QA. Reinstalling a previously built normal candidate is also sufficient if its source/artifact identity is still the intended candidate. Relaunching the diagnostic app without the environment flags is insufficient: its bundle still selects diagnostics.

## Fixed iOS result, 2026-10-26

The sanitized `mobile-evidence/20261026/ios-fixed-{driver,network,performance}.json` reports identify source `66b4374b31cb734912750fb2bad88a72f0d8051e`, embedded Release bundle SHA-256 `e2b44fabd9c370319104cabef92f9c3bcd28be25ae0a499826bfecfdc175f722`, and iPhone 18 Pro / iOS 27.0 simulator `50231799-2BC1-4440-BEA8-D0F4F8EE40C0`. Driver assertions passed; network upload and hydration each transported 20,012 queued operations. Warm search P95 was 2.229ms (20 samples, 10,000 records / 1,000 documents); first page was 22.376ms. The service-ingest fixture still observed a 133.317ms timer gap, exceeding the 100ms target. Database reopen/home-list timing is not app cold launch. No physical-device performance or ordinary UI workflow completion is established by these reports.

## Fixed Android result, 2026-10-26

Fixed Android diagnostics completed on source `ea130b85762ae1a8155e4198922503df380f77f3`, Release APK SHA-256 `97f114cb893cfee32a366a545b053502fdb87e0e63d45b62fd594342b13dcee0`, Pixel_9_Pro emulator `emulator-5554` / Android 16 API 36. Sanitized `mobile-evidence/20261026/android-fixed-{driver,network,performance}.json` includes all driver PASS assertions and structural SQLITE_FULL `messageControlCodes` evidence without raw error text. Actual HTTP upload/hydration transported 20,012 unique operations; full pagination returned 10,000 rows across 50 pages. Warm search P95 was 2.608ms (20 samples; 10,000 records / 1,000 documents), first page 25.603ms. Observed timer gaps were 2,260.853ms during network upload, 895.523ms during hydration and 3,094.993ms during service-fixture ingest: the 100ms performance gate is not met. Emulator scheduling versus synchronous work has not been isolated; no causal attribution is asserted. App cold launch and physical-device performance remain unmeasured. All four ordinary UI cells remain incomplete, and real-bucket repair is not accepted by this evidence.
