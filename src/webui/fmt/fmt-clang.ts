// C-family 格式化 provider: clang-format as WASM — one engine for C, C++, C#,
// Java, Objective-C and Protobuf. clang-format infers the language from a file
// name, so each lang id maps to a virtual filename. Default (LLVM) style,
// 2-space indent — matching both clang-format's own default and the editor.
// Lazy asset /webui-fmt-clang.js + sidecar .wasm — never import statically.

import init, { format as clangFormat } from "@wasm-fmt/clang-format/web";
import { fmtProvider } from "./manifest.ts";

/** Build-time inlining canary — scripts/build.ts asserts on it. */
export const MARKER = "mh-fmt-clang";

const FILENAME: Record<string, string> = {
  c: "block.c", h: "block.h",
  cpp: "block.cc", "c++": "block.cc", cc: "block.cc", hpp: "block.hpp",
  csharp: "block.cs", cs: "block.cs",
  java: "Block.java",
  objectivec: "block.m", objc: "block.m", "objective-c": "block.m",
  protobuf: "block.proto", proto: "block.proto",
};

let ready: Promise<unknown> | null = null;

export async function format(
  code: string,
  lang: string,
  cursor: number,
): Promise<{ text: string; cursor: number }> {
  ready ??= init(fmtProvider("clang")!.wasm!.route);
  await ready;
  return { text: clangFormat(code, FILENAME[lang] ?? "block.cc"), cursor };
}
