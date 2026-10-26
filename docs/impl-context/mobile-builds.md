# Mobile checks and Release build reproduction

The dedicated `Mobile` workflow leaves the existing core CI intact. It installs the root and mobile projects separately with their committed Bun locks, then builds the packaged editor, typechecks, lints and runs mobile unit tests plus scope tests. Root `bun test` remains the existing core CI gate; its known unused-i18n-string failure is not suppressed by this workflow.

## Scheduling

- Pull requests affecting mobile or shared `src/` code run checks. Mobile native dependencies, app/Metro/Babel configuration, plugins, assets, scripts or the workflow itself also build both native packages.
- Pushes to `feat/mobile`, `dev` and `main` build both platforms when mobile/shared inputs change. Other branch pushes run checks only unless native configuration changes.
- A manual dispatch always runs checks and both builds. Documentation-only changes skip both expensive jobs. Scope is calculated in a small always-visible job, without top-level path filtering.

## Local commands

Use a disposable clean checkout: `expo prebuild --clean` replaces generated `android/` or `ios/` directories. Install native tools separately: Java 21 and an Android SDK for Android; macOS, Xcode 26.6 and CocoaPods for iOS. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` for Android. No Metro server or physical device is needed.

```sh
bun install --frozen-lockfile
cd apps/mobile
bun install --frozen-lockfile
bun run build:editor
bun run typecheck
bun run lint
cd ../..
bun test ./apps/mobile/src ./scripts/mobile-ci-scope.test.ts
bun apps/mobile/scripts/native-build.ts android
# On macOS, instead of the Android command:
bun apps/mobile/scripts/native-build.ts ios
```

The helper calls the installed Expo CLI with `bun --no-env-file x --no-install`, regenerates native projects through CNG, and builds Release. Android uses Gradle `:app:assembleRelease` with Java 21. The generated Expo release APK uses the template development signing key: it is installable for testing and unsuitable as a store/distribution signing identity. iOS runs `pod install` and `xcodebuild` for the generic iOS Simulator destination with `CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES`. Ad-hoc signing preserves SecureStore simulator entitlements. No provisioning profile, Apple account, physical-device or App Store credentials are used.

## Artifacts and provenance

Each native job uploads `mobile-<platform>-<commit SHA>` for 14 days. Files are under `apps/mobile/dist/native/<platform>/`:

- Android: `metahub-release.apk` and `android-package.txt` with actual package/minimum/target SDK metadata.
- iOS: `metahub-simulator-release.zip` containing `Metahub.app`, plus the resolved `Podfile.lock`. Unzip and install with `xcrun simctl install booted /absolute/path/Metahub.app`.
- Both: `manifest.json` records commit, dirty state including untracked files, Bun/Expo/React Native versions, runner image, tool/SDK versions, SHA-256 of source configuration and both Bun locks, generated native configuration/lock hashes and artifact bytes/SHA-256. It also records a sorted source-input SHA-256 inventory and combined fingerprint, including untracked mobile/shared/build source files and tracked deletions. A source change during native compilation fails the build instead of labeling a moving snapshot as a fixed candidate. `build.log` captures command output. Public Expo configuration is hashed without writing its potentially private `extra` values into logs.

Build failures still upload the partial manifest and logs when the helper has started. Compiler intermediates are removed before upload. Install/setup failures before the helper starts appear in workflow logs and have no native manifest. Avoid supplying credentials or private content in build environment/configuration; native tool logs are not a general secret scrubber.

For a reproduction, check out the artifact's commit, use Bun 1.3.14, match its recorded tool/SDK versions and run the frozen installs above. For exact iOS pod resolution, save the artifact's `Podfile.lock` outside the disposable native directory and set `MOBILE_POD_LOCK=/absolute/path/Podfile.lock` when running the iOS helper; it then uses `pod install --deployment`. The manifest has no clock timestamp and captures resolved inputs, but the hosted runner image and native dependency repositories can change. This is a traceable build recipe, not a claim of byte-identical APK/ZIP output across hosts. Native generated files remain ignored; locks and configuration hashes accompany each artifact for drift diagnosis.

The hosted runners are pinned by OS label to `ubuntu-24.04` and `macos-26`, with explicit Xcode 26.6 selection. These labels and Xcode availability were checked against the official [runner image inventory](https://github.com/actions/runner-images) and [macOS 26 image manifest](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) on 2026-10-26. A future runner removing Xcode 26.6 fails explicitly until this recipe is reviewed.

## Acceptance boundary

These jobs verify compilation and archive installable test packages. They do not assert device launch, SecureStore behavior, offline/reconnect/convergence, physical iOS installation, accessibility, or performance acceptance. Those gates stay in the native completion ledger and require separately recorded runtime evidence. The helper and workflow were syntax/scope-tested during implementation; a completed hosted native run is still required before claiming CI build acceptance.


Normal candidate builds reject diagnostic selectors, pass explicit disabled values to subprocesses, and suppress both Bun and Expo local dotenv loading. See [the separate Release diagnostics recipe](mobile-release-diagnostics.md) for opt-in synthetic benchmark artifacts.
