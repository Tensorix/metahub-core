// TOML 格式化 provider: taplo as WASM (@wasm-fmt build). Mapped from the
// "ini" lang id (COMMON_LANGS labels it "INI / TOML"); genuine INI that isn't
// valid TOML errors out — the button flashes and the text stays untouched.
// Lazy asset /webui-fmt-taplo.js + sidecar .wasm — never import statically.

import init, { format as taploFormat } from "@wasm-fmt/taplo_fmt/web";
import { fmtProvider } from "./manifest.ts";

/** Build-time inlining canary — scripts/build.ts asserts on it. */
export const MARKER = "mh-fmt-taplo";

let ready: Promise<unknown> | null = null;

export async function format(
  code: string,
  _lang: string,
  cursor: number,
): Promise<{ text: string; cursor: number }> {
  ready ??= init(fmtProvider("taplo")!.wasm!.route);
  await ready;
  return { text: taploFormat(code), cursor };
}
