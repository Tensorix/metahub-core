// Lua 格式化 provider: StyLua as WASM (@wasm-fmt build), StyLua defaults.
// Lazy asset /webui-fmt-lua.js + sidecar .wasm — never import statically.

import init, { format as luaFormat } from "@wasm-fmt/lua_fmt/web";
import { fmtProvider } from "./manifest.ts";

/** Build-time inlining canary — scripts/build.ts asserts on it. */
export const MARKER = "mh-fmt-lua";

let ready: Promise<unknown> | null = null;

export async function format(
  code: string,
  _lang: string,
  cursor: number,
): Promise<{ text: string; cursor: number }> {
  ready ??= init(fmtProvider("lua")!.wasm!.route);
  await ready;
  return { text: luaFormat(code), cursor };
}
