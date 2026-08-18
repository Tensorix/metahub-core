// `@joplin/turndown-plugin-gfm` ships no types. It exports turndown plugins; we
// only use the bundled `gfm` (strikethrough + tables + task lists) via
// `service.use(gfm)`. The Joplin fork (vs the original turndown-plugin-gfm)
// handles real-world clipboard tables: block elements inside cells are
// flattened, headerless tables get an empty header row instead of being kept as
// raw HTML, `|` in cells is escaped as `\|`, colspan pads empty cells.
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
