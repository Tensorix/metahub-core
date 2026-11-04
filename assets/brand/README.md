# MetaHub brand and product narrative

This is the shared brand reference for the website, repository READMEs, and product introductions. Website hero and README title lines differ on purpose; both still describe the same shared workspace. [Website design](../../website/DESIGN.md) describes the current marketing-site implementation; [core UI theme](../../src/core/ui-theme.ts) and [WebUI styles](../../src/webui/styles.css) remain the authority for product UI.

## Product thesis

MetaHub is a **local-first shared workspace**: notes, typed tables, and agent-built sites. Humans and agents read and write the same materials. People use the desktop app or WebUI; external agents use the CLI or API.

Lead with the work people can keep doing together. Persistent context is useful, but do not position MetaHub as an AI memory product, an agent runtime, or a chat app. MetaHub stores and exposes the workspace; the user's external agent runs the model. Do not imply that saving an edit automatically makes an agent understand or act on it.

Use **MetaHub** in product prose. Keep `metahub`, `mh`, package names, paths, and command names unchanged in code.

## Locked slogan and supporting copy

| Role | English | 简体中文 |
| --- | --- | --- |
| Website hero | Where you and your AI keep working. | 你和 AI 接着往下做的地方。 |
| Website supporting sentence | Notes, tables, and simple sites. A local-first workspace you and your AI can read and write. | 笔记、数据表和简单小站。一个你和 AI 都能读写的本地优先工作区。 |
| README title line | A local-first workspace you and your agents share. | 你和 Agent 共享的本地优先工作空间。 |
| README lead | Markdown notes, typed tables, and simple agent-built sites in one shared workspace; people use the app/browser, agents use the CLI. | Markdown 笔记、类型化数据表与 Agent 简单站点；人用 App/浏览器，Agent 用 CLI。 |
| Primary CTA | Download desktop | 下载桌面版 |
| Secondary CTA | Connect an agent | 连接 Agent |
| Badges, in both languages | Write · See · Continue | Write · See · Continue |

Website and GitHub README intentionally use **different** lead lines: the site keeps the locked emotional hero; READMEs lead with the concrete workspace framing and a Write / See / Revise / Keep yours / Trace-and-undo Why section. Do not force the website hero into README, or the README title into the website hero.

Preserve the website slogan's wording and punctuation. On the website, emphasize only **keep working** / **接着往下做** in logo blue `#335CFF`; the rest uses the ordinary warm foreground `#37352F`. Do not introduce another hero-only dark color or multicolor/gradient text. GitHub READMEs use plain bold text rather than inline color styling.

For Chinese, keep “接着往下做” together. The current hero breaks after “你和 AI”, then renders “接着往下做的地方。” as one line, scaling to fit phones. Use normal Chinese character spacing and appropriate leading rather than applying tight English tracking. `AI`, `Agent`, and product names retain readable spacing in Chinese sentences.

## The collaboration loop

**You write → AI writes back → you revise → AI explicitly re-reads.**

**你写 → AI 写回 → 你修改 → AI 重新读取。**

Show concrete material changing, with a visible result the person can inspect and revise. Live UI refresh and agent re-reading are different actions: after the person changes the source, the next agent step reads that latest source before writing an update.

| Scenario | Shared material | Proof of continuation |
| --- | --- | --- |
| Notes / 笔记 | Event plan and invitation | The person changes the date; the invitation changes after the agent re-reads the plan. |
| Tables / 数据表 | Task records shown as a board or table | The person updates a task; the agent reads the latest statuses and writes a new summary. |
| Sites / 小站 | Agent-built sign-up page and attendee table | A registration writes back to the workspace; the agent reads the updated list. |

The three website demos share one stage with tabs. Keep manual interaction and replay; do not stack three separate full demos vertically. Website examples use sample data and simulated AI, which must be disclosed. A real site's guest writes require explicit table/operation grants.

## Two palettes, with distinct roles

The logo and the App theme are related but separate palettes. Do not replace the App's colors with the saturated logo palette, or desaturate all marketing accents to look like the App.

| Layer | Colors | Use |
| --- | --- | --- |
| Logo artwork | Blue `#335CFF`, violet `#8B6CEF`, teal `#16B8AD`, coral `#F48265`; pale tile `#F5F7FC` | The approved modular mark. Original color targets, not guaranteed uniform raster fills. |
| Marketing accents | The same four logo colors | Hero blue, small scene icons, active workflow-node outlines, and the hosted-site mark. Add energy in purposeful, limited places. |
| Interface foundations | White `#FFFFFF`, warm surfaces `#FAFAF9` / `#F7F7F5` / `#F1F1EF`, foreground `#37352F`, secondary `#595750`, muted `#6F6D66`, borders `#EAE9E6` / `#D8D7D3` | Main site surfaces and product demonstrations, following `LIGHT_THEME`. |
| Interface actions | Blue `#3867B2`, soft blue `#EDF2F9` | Primary buttons, focus, selection, and product controls. Hero emphasis remains logo blue. |
| Readable supporting accents | Purple `#79619D`, teal `#397D76`, orange `#A06436` | Small labels on suitable pale surfaces; darken further where needed for contrast. |

Keep success, warning, and error meanings intact. Bright logo colors may decorate a labeled icon or outline; they are not automatically suitable for small text. Check text contrast on its actual background. Retain the App's dark neutral palette for terminal examples.

## Product UI fidelity

Marketing demonstrations should feel like the real MetaHub App / WebUI. Prefer annotated screenshots or compact CSS reproductions of actual components; do not invent a parallel card or control system.

- Follow the actual sidebar, window chrome, document editor, table cells, and main-app board. Use versioned product screenshots in [`website/public/assets`](../../website/public/assets/) as supporting evidence and current source as the authority for controls.
- Board cards omit the grouping property; changing a group is shown by dragging. Table status cells use the App's option chips and searchable picker, with a bottom sheet on phones. See [`board.tsx`](../../src/webui/board.tsx), [`cells.tsx`](../../src/webui/cells.tsx), and [`table.tsx`](../../src/webui/table.tsx).
- Documents show ordinary text and paragraphs. Demo-only date controls, agent narration, summaries, and write-back explanations sit outside the App frame so they do not imply nonexistent product UI.
- A hosted site can have its own visual identity; its write-back table still looks like MetaHub. Do not present the site's visitor form as a built-in App form builder.
- Keep the marketing site static HTML, CSS, and vanilla JavaScript. Preserve keyboard access, mobile interaction, reduced-motion behavior, and bilingual labels.

When updating copy, check this guide, both repository READMEs, [`website/public/copy.js`](../../website/public/copy.js), initial English HTML, and [`website/DESIGN.md`](../../website/DESIGN.md) together. Do not describe a simulated walkthrough as a live agent connection or label an old screenshot as the current release.

## Logo variants

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
