// `turndown-plugin-gfm` ships no types. It exports turndown plugins; we only use
// the bundled `gfm` (strikethrough + tables + task lists) via `service.use(gfm)`.
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
