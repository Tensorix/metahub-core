// The "core" 格式化 provider bundle: prettier standalone + its first-party
// plugins (js/ts via babel, css family, html, yaml), @prettier/plugin-php and
// sql-formatter — everything that formats in pure JS. Built as its own lazy
// asset (/webui-fmt.js, see manifest.ts); NEVER import this module statically
// from app code or the whole engine lands in webui.js.
//
// ts/tsx use the babel plugin's "babel-ts" parser instead of the official
// typescript plugin: prettier supports it as a first-class TS parser and it
// keeps ~430KB (gz) of duplicate parser out of this bundle. If an exotic TS
// construct ever mis-formats, switching PARSER back to "typescript" (+ the
// plugin import) is a two-line change.

import { formatWithCursor } from "prettier/standalone";
import * as pluginBabel from "prettier/plugins/babel";
import * as pluginEstree from "prettier/plugins/estree";
import * as pluginPostcss from "prettier/plugins/postcss";
import * as pluginHtml from "prettier/plugins/html";
import * as pluginYaml from "prettier/plugins/yaml";
import * as pluginPhp from "@prettier/plugin-php/standalone";
import type { Plugin } from "prettier";
import { format as sqlFormat } from "sql-formatter";

/** Build-time inlining canary — scripts/build.ts asserts on it. */
export const MARKER = "mh-fmt-core";

// plugin-php's standalone build types as a bare namespace; it IS a Plugin.
const PLUGINS: Plugin[] = [
  pluginBabel, pluginEstree, pluginPostcss, pluginHtml, pluginYaml,
  pluginPhp as unknown as Plugin,
];

const PARSER: Record<string, string> = {
  javascript: "babel", js: "babel", jsx: "babel", mjs: "babel", cjs: "babel",
  typescript: "babel-ts", ts: "babel-ts", tsx: "babel-ts",
  css: "css", scss: "scss", less: "less",
  xml: "html", html: "html",
  yaml: "yaml", yml: "yaml",
  php: "php",
};

export async function format(
  code: string,
  lang: string,
  cursor: number,
): Promise<{ text: string; cursor: number }> {
  if (lang === "sql") {
    // sql-formatter has no cursor tracking; the dispatcher clamps.
    return { text: sqlFormat(code, { language: "sql", tabWidth: 2 }), cursor };
  }
  const parser = PARSER[lang];
  if (!parser) throw new Error(`不支持的语言:${lang}`);
  const r = await formatWithCursor(code, {
    parser,
    plugins: PLUGINS,
    tabWidth: 2, // match the editor's INDENT / tab-size:2
    cursorOffset: Math.max(0, cursor),
  });
  return { text: r.formatted, cursor: r.cursorOffset };
}
