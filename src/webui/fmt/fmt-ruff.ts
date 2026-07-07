// Python 格式化 provider: Ruff's formatter (Black-compatible) as WASM, the
// formatter-only @wasm-fmt build (~1/9 the size of Astral's full-linter wasm).
// Lazy asset /webui-fmt-ruff.js + sidecar .wasm — never import statically.
// Ruff defaults apply (4-space indent, 88 cols): Python code should look like
// Python, not like this editor's 2-space JS.

import init, { format as ruffFormat } from "@wasm-fmt/ruff_fmt/web";
import { fmtProvider } from "./manifest.ts";

/** Build-time inlining canary — scripts/build.ts asserts on it. */
export const MARKER = "mh-fmt-ruff";

let ready: Promise<unknown> | null = null;

export async function format(
  code: string,
  _lang: string,
  cursor: number,
): Promise<{ text: string; cursor: number }> {
  ready ??= init(fmtProvider("ruff")!.wasm!.route);
  await ready;
  // No cursor tracking in ruff_fmt; the dispatcher clamps.
  return { text: ruffFormat(code, "block.py"), cursor };
}
