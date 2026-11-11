# Shared Web database validation — 2026-11-09

The mobile database route now loads one locally bundled WebView. The table,
board, calendar, timeline, tabs, filters, sorting and field menus use the same
Preact implementation as browser/desktop. Native record details and the replica
remain native. The obsolete RN database renderers and FlashList dependency were
removed. No CRDT data format, saved view IDs or sync protocol was changed.

## Checks

- Mobile TypeScript and ESLint: passed.
- Web UI TypeScript: passed.
- Web app and worker browser builds: passed.
- Offline database HTML build: passed; approximately 1,142 KB before transport compression.
- Web/shared/replica/native-draft regression suite: 817 passed, including touch activation and retained-editor regressions.
- iOS simulator Release build: succeeded, zero errors (two existing build warnings).
- Simulator: all four views opened on the existing Laplace Dashboard database.
- Final Release: selected-cell editing opens the Chinese software keyboard; the
  editor remains above it and shows previous/next cell, cancel and done controls.
- Web record-opening action successfully navigates to the existing native detail sheet.
- Window tests: 50,000 rows, bounded mounted rows, at most 1,000 cached record
  bodies, refetch of evicted pages, rejection of old query responses, editor
  retained when its row scrolls out of view.
- Draft tests: native persistence acknowledgment, stale revision rejection,
  shared writer flush, restored draft overlay, workspace switch rejection.

## Repeatable host query benchmark

Run `bun scripts/benchmark-database.ts`. Five runs per fixture; reported P95 is
therefore the slowest of the five samples. These are Bun/SQLite host measurements,
not iPhone, Android, simulator bridge, startup or frame-rate measurements.

| Fixture | Index P95 | First 100 rows | Last 100 rows | Search + sort + sum P95 |
|---|---:|---:|---:|---:|
| 10,000 × 50 | 116 ms | 2 ms | 2 ms | 192 ms |
| 50,000 × 50 | 876 ms | 4 ms | 5 ms | 1,290 ms |

The text-heavy fixture serialized a 100-row page to approximately 384 KB.
Later pages use the retained ID index and do not repeat filtering or sorting.
Indexes retain IDs and partition membership, not complete record bodies.

## Phone acceptance remains separate

Actual iPhone 13 / Pixel 6a Release measurements are still required for the
1.5-second startup, 100 ms input, 55 FPS scrolling and memory targets. Simulator
results do not establish those targets. Android runtime, Chinese IME, accessibility,
rotation/background recovery, long-press edge dragging and sustained memory need
the specified device matrix. Use Instruments / Android Profiler to separate native
query, serialization, bridge, Web rendering and native/WebView memory.

The architecture remains shared Web if those measurements require further work.

## Mobile experience alignment — 2026-11-11

Implemented shared presentation metrics (touch mode, font scale and measured
container size), fixed create action with independently scrolling view tabs,
mobile toolbar panels, 48px table rows, compact 128px board cards, calendar date
dialogs and responsive timeline rows/title column. Editors retain input after
failed saves, display record/field context and navigate within the current record.
Native date controls follow the theme; WebView keyboard accessory duplication is
disabled. Draft status requires host acknowledgement. Changing the requested
view now sends a bridge message rather than reloading HTML under the same session.

Current checks:

- `bun test src/shared/views src/webui apps/mobile/src/lib/database`: 801 passed,
  0 failed, 3,113 expectations across 79 files.
- Web TypeScript; mobile TypeScript and lint; browser app/worker builds; offline
  database bundle (approximately 1,166 KB); `git diff --check`: passed.
- iOS Release built and installed on Metahub Preview (402px). Opened all four
  views and the contextual editor. The existing database has 16 undated records,
  so dated calendar/timeline content is not covered by that simulator fixture.
  No existing record content was changed.
- Synthetic browser fixture covered 10,000 rows × 50 fields at 390, 402, 412,
  768 and 1,440px, light/dark and enlarged text. Bounded DOM windows and no
  horizontal page overflow were observed. The 1,440px case used the embedded
  bundle, not a complete desktop application visual regression.
- 50,000-row virtual-window and 1,000-record cache limits are covered by tests;
  these are not device performance measurements.
- Android Release built and installed. Launch reached the connect-storage
  screen; no workspace was configured. The emulator also displayed a System UI
  not responding dialog. Android database runtime acceptance remains unverified.
- The final iOS editor was focused with its Web controls visible; the simulator
  hardware-keyboard configuration prevented a fresh software-keyboard capture.
  Final-build Chinese IME and keyboard-occlusion acceptance remains pending.

Screenshots are retained in
`/Users/noah/.codex/visualizations/2026/11/09/01a1bf0c-92ce-7363-8a3b-79dc4975b23e/database-alignment/`:
`aligned-final-table.png`, `aligned-final-board.png`,
`aligned-final-calendar.png`, `aligned-final-timeline.png`,
`aligned-final-editor.png`, and `aligned-android.png`.

Physical-device FPS, input/startup latency, sustained memory, VoiceOver/TalkBack,
and the complete rotation/background/gesture/failure matrix are still pending.
The implementation and simulator installation are delivered; full device
acceptance must not be inferred from these checks.
