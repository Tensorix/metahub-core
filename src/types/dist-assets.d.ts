// Bun import attributes aren't modeled by tsc: `with { type: "text" }` yields
// the file's contents as a string, `with { type: "file" }` a runtime path.
// These ambient declarations cover the dist/ artifacts the compile-only
// entries embed (src/cli/compiled-entry.ts, apps/desktop/src/server-bundle.ts)
// so those imports typecheck without per-line suppressions.

declare module "*/dist/webui.js" {
  const text: string;
  export default text;
}
declare module "*/dist/sw.js" {
  const text: string;
  export default text;
}
declare module "*/dist/db-worker.js" {
  const text: string;
  export default text;
}
declare module "*/dist/sqlite3.wasm" {
  const path: string;
  export default path;
}
