// Language → format engine routing for the code block's 格式化 button. Pure
// data + lookups, zero dependencies — this lives in the main bundle and is the
// `canFormat` gate; the heavy engines stay in the lazy provider bundles
// (manifest.ts). Keys cover the COMMON_LANGS ids (blocks.ts) plus the aliases
// people actually type in fences (js, py, yml, …).

/** Engines that run inline in the main bundle. */
export type InlineEngine = "json" | "reindent";
/** Lazily-loaded provider ids (see manifest.ts). */
export type ProviderEngine = "core" | "ruff" | "gofmt" | "clang" | "lua" | "taplo" | "sh";
export type FmtEngine = InlineEngine | ProviderEngine;

const BY_LANG: Record<string, FmtEngine> = {
  // strict JSON: native JSON.parse/stringify — instant, no engine download
  json: "json",
  // dialects (comments / single quotes / unquoted keys / trailing commas) need
  // a real parser → prettier's json5 / jsonc parsers in the core bundle
  jsonc: "core", json5: "core",

  // prettier core bundle (+ sql-formatter, @prettier/plugin-php)
  javascript: "core", js: "core", jsx: "core", mjs: "core", cjs: "core",
  typescript: "core", ts: "core", tsx: "core",
  css: "core", scss: "core", less: "core",
  xml: "core", html: "core", // COMMON_LANGS labels xml as "HTML / XML"; parser is html
  yaml: "core", yml: "core",
  php: "core",
  sql: "core",

  // per-language wasm providers
  python: "ruff", py: "ruff", python3: "ruff",
  go: "gofmt", golang: "gofmt",
  c: "clang", h: "clang", cpp: "clang", "c++": "clang", cc: "clang", hpp: "clang",
  csharp: "clang", cs: "clang", java: "clang",
  objectivec: "clang", objc: "clang", "objective-c": "clang",
  protobuf: "clang", proto: "clang",
  lua: "lua",
  ini: "taplo", toml: "taplo", // COMMON_LANGS labels ini as "INI / TOML"; taplo formats TOML
  bash: "sh", shell: "sh", sh: "sh", zsh: "sh",

  // brace languages without a browser engine → indent-only fallback
  rust: "reindent", rs: "reindent",
  swift: "reindent",
  kotlin: "reindent", kt: "reindent",
  perl: "reindent", pl: "reindent",
  // deliberately absent (no button): ruby (do/end nesting defeats brace
  // reindent), markdown (conflicts with our own dialect round-trip), makefile,
  // diff, plain text, and anything unknown.
};

/** Engine for a fence language, or null when the block gets no 格式化 button. */
export function langEngine(lang: string | undefined): FmtEngine | null {
  if (!lang) return null;
  return BY_LANG[lang.trim().toLowerCase()] ?? null;
}

export function canFormat(lang: string | undefined): boolean {
  return langEngine(lang) !== null;
}
