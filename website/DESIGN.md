# Website design

A product introduction for a local-first shared workspace: notes, typed tables, and agent-built sites. Humans and external agents read and write the same materials. Mode: Persuade. Preserve the multicolor MetaHub mark and cobalt accent.

- Background: #fafbf9; foreground: #202724; secondary text: #65716b.
- Primary action: #335cff; borders: #dce2dc; quiet surfaces: #eef2ed.
- Type: self-hosted Manrope (regular and bold), system CJK fallback; monospace only for commands and paths.
- Chinese typography: full-width glyphs use normal tracking and more leading. The hero breaks after “你和 AI”, keeps “接着往下做” blue and intact, and scales the complete second line to phone widths. Supporting copy uses balanced or natural wrapping; app examples keep their compact document/table hierarchy.
- Locked hero: “Where you and your AI keep working.” / “你和 AI 接着往下做的地方。” Badges: Write · See · Continue. CTAs: Download desktop / Connect an agent.
- Content width: 1200px (1240px on wide screens). Centered compact hero followed by one fixed-height demonstration area with Notes / Tables / Sites tabs. The three demos stay in the same place and retain independent interaction state.
- App fidelity: colors from `src/core/ui-theme.ts`; font stack, 6/8px radii, sidebar tabs, document spacing, data grid, and main-app board patterns from `src/webui/styles.css`. The sample hosted site uses a quiet green palette; the write-back table keeps the app's neutral palette. Agent narration and playback controls remain outside the app frame.
- Sequence: you write → AI writes back → you revise → AI explicitly re-reads. Each scene offers one automatic walkthrough and manual, repeatable interactions. Notes update only after re-reading; board summaries reflect a read snapshot; a site sign-up writes to the displayed attendee table.
- Motion: 350ms scene transition; 520ms card movement between columns; bounded read indicator, paragraph reveal, and row insertion. User changes, scene/language switches, hidden tabs, and offscreen demos cancel pending work. Reduced motion skips autoplay and spatial effects but keeps textual feedback.
- Responsive: 1100px, 900px, 700px, and 440px. Sidebar recedes on mobile; cards scroll inside their board. On phones, the site and its write-back table switch in place, with successful sign-up revealing the table. No vertical scene stack.
- Localization: English default, persisted English/Chinese switch. All visible and assistive labels live in `public/copy.js`; task IDs, dates, and sample identities remain language-independent. User-entered names are preserved literally. Metadata updates with language. Source app screenshots remain explicitly versioned English evidence.
- Accessibility: semantic tabs with arrow/Home/End navigation, visible focus, native selects as an alternative to card dragging, status announcements for manual operations, and reset/pause controls.
- Supporting content: expandable real app screenshots, local ownership and sync, external-agent connection/CLI example, and desktop/CLI installation. All claims are grounded in the repository. Demonstrations are explicitly simulated and use page-local data only.
