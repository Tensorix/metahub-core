# Metahub brand variants

- `color/`: default, blue/teal/violet/coral modules on a pale rounded tile.
- `blue/`: preserved cobalt monochrome alternative.
- Root `icon-*.png`: generated compatibility copies of the default color family.

Each family contains 1024, 512, 192, 180 and 32 px PNGs. Run `bun run apps/desktop/scripts/gen-icon.ts` after changing either family. It updates desktop packaging, the standalone splash, embedded server icons and client image constants without external image tooling.

Settings → Appearance → Logo colors switches sidebar, About, QR badge and browser favicon immediately. The `mh-brand` localStorage preference defaults to `color`, persists per origin/device and synchronizes between tabs. Installed desktop/PWA icons and the startup splash use the color default; operating-system launcher icons do not change with the in-app setting.

## Artwork provenance

Both raster families were produced using the built-in imagegen tool from the user-approved concept sheets, then resized with macOS sips. Blue: white modular M on cobalt tile, target #335CFF. Color: faithfully extract the approved light app tile, retain modular M geometry and negative-space hub; cobalt #335CFF, teal #16B8AD, violet #8B6CEF, coral #F48265, pale #F5F7FC background and transparent exterior. These are generation color targets rather than guaranteed uniform vector fills.

## Design archives and light/dark icons

Both original full design sheets are preserved without alteration in `designs/color-concept.png` and `designs/blue-terracotta-concept.png`. The latter intentionally retains the terracotta exploration as part of the original sheet.

`color/light`, `color/dark`, `blue/light` and `blue/dark` each contain all five export sizes. `blue/icon-*.png` retains the original white-on-cobalt design. The in-app blue light/dark options are blue-on-pale and brighter blue-on-navy, respectively. All runtime images are embedded, so installed/offline builds require no external image paths.

The separate Logo background setting persists under `mh-brand-tone`, defaults to `light`, and works independently of the interface theme and logo palette. Sidebar, About, QR badge and favicon subscribe to both choices. New light/dark exports were made with built-in imagegen edits of the approved color master: preserve modular geometry and transparent margins, replace only tile/channel colors (pale #F5F7FC or navy #10182F) and module colors (original multicolor, cobalt #335CFF for blue/light, #6185FF for blue/dark). Sizes were exported using sips.

## Consistent display size

`frames.json` records the visible tile bounds of each 192px light/dark export. Bounds were measured from alpha >= 128, squared around their center, and padded by 2px per side for antialiasing. The build embeds these frames with the image data. `BrandMark` positions each original PNG within the same clipped square, so transparent canvas margins cannot make one preview look larger than another. Update the frame measurements when replacing artwork; original PNGs and concept sheets remain untouched.
