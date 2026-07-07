// Shell 格式化 provider: shfmt (mvdan/sh) via its official GopherJS build —
// pure JS, no wasm sidecar. Lazy asset /webui-fmt-sh.js — never import
// statically. Indent(2) matches the editor; KeepComments is mandatory or the
// printer silently drops them.

import sh from "mvdan-sh";

/** Build-time inlining canary — scripts/build.ts asserts on it. */
export const MARKER = "mh-fmt-sh";

export async function format(
  code: string,
  _lang: string,
  cursor: number,
): Promise<{ text: string; cursor: number }> {
  const { syntax } = sh;
  const parser = syntax.NewParser(syntax.KeepComments(true));
  const printer = syntax.NewPrinter(syntax.Indent(2));
  const file = parser.Parse(code, "block.sh"); // throws ParseError with line/col
  return { text: printer.Print(file), cursor };
}
