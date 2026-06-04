# Metahub Desktop

Electron shell over the core sync server. The window loads the WebUI served by a
Bun **sidecar** over loopback HTTP.

- **dev**: the sidecar runs from source via `bun run src/server-entry.ts`
  (WebUI builds lazily). Requires Bun on PATH.
- **prod**: the sidecar is a self-contained `bun build --compile` binary that
  embeds the Bun runtime, `bun:sqlite`, the core server, and the prebuilt WebUI
  bundle. The packaged app needs **neither Bun on PATH nor any source tree**.

Data lives in `~/.metahub` (shared with the `mh` CLI). Override via `METAHUB_HOME`.

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

Out of scope for now: code signing/notarization, auto-update (electron-updater),
release CI.
