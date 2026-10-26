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
