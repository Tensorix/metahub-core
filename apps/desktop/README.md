# Metahub Desktop

English · [简体中文](./README.zh-CN.md) · [Project README](../../README.md)

The desktop app for [metahub](../../README.md): a Notion-like GUI over the core
sync server, plus a **Quick Notes** float window (global hotkey / tray, stays
above fullscreen apps on any Space).

Under the hood it is an Electron shell; the window loads the WebUI served by a
Bun **sidecar** over loopback HTTP.

- **dev**: the sidecar runs from source via `bun run src/server-entry.ts`
  (WebUI builds lazily). Requires Bun on PATH.
- **prod**: the sidecar is a self-contained `bun build --compile` binary that
  embeds the Bun runtime, `bun:sqlite`, the core server, and the prebuilt WebUI
  bundle. The packaged app needs **neither Bun on PATH nor any source tree**.

Data lives in `~/.metahub` (shared with the `mh` CLI). Override via `METAHUB_HOME`.

## Install (Homebrew)

```sh
brew install --cask tensorix/tap/metahub-app
```

Unsigned (open-source). Via Homebrew the app isn't browser-quarantined; if
Gatekeeper still blocks it, add `--no-quarantine`. The CLI is a separate formula:
`brew install tensorix/tap/metahub-cli`. Both are kept current by CI on each
release (see `apps/desktop/scripts/gen-cask.ts`, `scripts/gen-formula.ts`, and
the `update-tap` jobs). Tap repo: <https://github.com/Tensorix/homebrew-tap>.

## Develop

```sh
bun install
bun run dev        # build main/preload, launch Electron, spawn sidecar from source
```

## Build artifacts

```sh
bun run build      # build:main + build:icon + build:sidecars
bun run dist:mac   # → release/*.dmg, *.zip (arm64 + x64)
bun run dist:win   # → release/*.exe (NSIS)
bun run dist:linux # → release/*.AppImage, *.deb
bun run dist       # current platform
```

`build:sidecars` cross-compiles all four sidecar binaries into `resources/`
(named to match electron-builder's `${arch}` macro). It runs the root
`bun run build` first if `dist/webui.js` is missing.

`build:icon` writes `build/icon.png` (1024×1024 placeholder). electron-builder
derives `.icns` / `.ico` / `.png` from it — replace that file with a real logo
to rebrand. Tray icon stays `assets/trayTemplate.png`.

## Cross-platform notes

`bun build --compile` cross-compiles all sidecar binaries from a single host.
Installer creation is more constrained:

- **macOS** dmg/zip (incl. x64) build directly on a Mac. Unsigned / ad-hoc for
  now (`identity: null` in `electron-builder.yml`) — to sign/notarize later, set
  an identity + entitlements there; no code changes needed.
- **Windows** NSIS from macOS needs **wine**. Without it, run `dist:win` on
  Windows or in CI.
- **Linux** `.deb` from macOS may need `dpkg`/`fakeroot` (AppImage usually
  builds fine). If unreliable, run `dist:linux` on Linux or in CI.

## Core auto-update

The app ships **independently** from `core` (CLI + sync server). The packaged
app embeds one sidecar as an offline fallback, but on every launch it checks the
core GitHub Releases for a newer sidecar and downloads it into
`<userData>/core/` — applied on the **next** launch (never hot-swapping the
running one). See `src/core-updater.ts`. This lets core release frequently
without repackaging the (slow, 3-OS) Electron app.

- Channel: GitHub Releases (`v*` tags), verified against `SHA256SUMS-sidecars.txt`.
- Unsigned-safe: a binary fetched programmatically isn't macOS-quarantined; we
  strip the attribute defensively anyway.
- `resolveSidecarCommand()` prefers the cached binary over the bundled one. The
  Settings footer shows the **App** (shell) and **Core** (running sidecar, via
  `/api/version`) versions.

## Releasing

Versions are independent. Bump the version, commit on `main`, then push the tag:

```sh
# desktop shell (3-OS installers → release-desktop.yml)
#   bump apps/desktop/package.json, commit, then:
cd apps/desktop && bun run release      # tags desktop-v<version>

# core (CLI + sidecar binaries → release.yml; also the auto-update source)
#   bump root package.json, commit, then:
bun run release                          # tags v<version>
```

Out of scope for now: code signing/notarization (unsigned/ad-hoc by design).

## License

[AGPL-3.0-only](../../LICENSE).
