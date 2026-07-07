// Single source of truth for the lazy code-format provider assets. Imported by
// the browser loader (routes), the server (src/webui/server/assets.ts getters +
// routes), the build (scripts/build.ts bundling + wasm copy), the static shell
// (scripts/build-shell.ts) and the smoke test — pure data, no dependencies, so
// every consumer stays in step when a provider is added or renamed.
//
// Each provider is one lazily-imported ESM bundle served on `js`, plus an
// optional sidecar `.wasm` asset the bundle init()s by URL. None of these are
// referenced statically from webui.js — the loader imports `js` through a
// runtime variable, so the main bundle never inlines them.

export interface FmtProvider {
  /** Registry id, referenced by lang-map.ts. */
  id: string;
  /** Serve route of the provider bundle (also its dist/ artifact name). */
  js: string;
  /** Bundle entrypoint, relative to src/webui/. */
  entry: string;
  /** Sidecar wasm: serve route + the npm package/file it is copied from. */
  wasm?: { route: string; pkg: string; file: string };
}

export const FMT_PROVIDERS: FmtProvider[] = [
  // prettier standalone + plugins (js/ts/css/html/yaml/php) + sql-formatter
  { id: "core", js: "/webui-fmt.js", entry: "fmt/fmt-core.ts" },
  {
    id: "ruff", js: "/webui-fmt-ruff.js", entry: "fmt/fmt-ruff.ts",
    wasm: { route: "/webui-fmt-ruff.wasm", pkg: "@wasm-fmt/ruff_fmt", file: "ruff_fmt_bg.wasm" },
  },
  {
    id: "gofmt", js: "/webui-fmt-gofmt.js", entry: "fmt/fmt-gofmt.ts",
    wasm: { route: "/webui-fmt-gofmt.wasm", pkg: "@wasm-fmt/gofmt", file: "gofmt.wasm" },
  },
  {
    id: "clang", js: "/webui-fmt-clang.js", entry: "fmt/fmt-clang.ts",
    wasm: { route: "/webui-fmt-clang.wasm", pkg: "@wasm-fmt/clang-format", file: "clang-format.wasm" },
  },
  {
    id: "lua", js: "/webui-fmt-lua.js", entry: "fmt/fmt-lua.ts",
    wasm: { route: "/webui-fmt-lua.wasm", pkg: "@wasm-fmt/lua_fmt", file: "lua_fmt_bg.wasm" },
  },
  {
    id: "taplo", js: "/webui-fmt-taplo.js", entry: "fmt/fmt-taplo.ts",
    wasm: { route: "/webui-fmt-taplo.wasm", pkg: "@wasm-fmt/taplo_fmt", file: "taplo_fmt_bg.wasm" },
  },
  // mvdan-sh (shfmt's GopherJS build) is pure JS — no wasm sidecar
  { id: "sh", js: "/webui-fmt-sh.js", entry: "fmt/fmt-sh.ts" },
];

export function fmtProvider(id: string): FmtProvider | undefined {
  return FMT_PROVIDERS.find((p) => p.id === id);
}
