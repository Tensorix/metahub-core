// Go 格式化 provider: the official gofmt compiled to WASM (@wasm-fmt build,
// ~285KB — the cheapest engine we ship). Lazy asset /webui-fmt-gofmt.js +
// sidecar .wasm — never import statically. gofmt has no options on purpose;
// output is the one true Go style (tabs).

import init, { format as goFormat } from "@wasm-fmt/gofmt/web";
import { fmtProvider } from "./manifest.ts";

/** Build-time inlining canary — scripts/build.ts asserts on it. */
export const MARKER = "mh-fmt-gofmt";

let ready: Promise<unknown> | null = null;

export async function format(
  code: string,
  _lang: string,
  cursor: number,
): Promise<{ text: string; cursor: number }> {
  ready ??= init(fmtProvider("gofmt")!.wasm!.route);
  await ready;
  return { text: goFormat(code), cursor };
}
