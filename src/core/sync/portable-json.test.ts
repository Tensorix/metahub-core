import { test, expect } from "bun:test";
import { decodeUtf8, cloneProtocolState } from "./portable-json.ts";
test("Hermes fallback decodes bounded Unicode chunks and rejects corrupted UTF-8", () => {
  const decoder = globalThis.TextDecoder, clone = globalThis.structuredClone;
  try {
    Object.defineProperty(globalThis, "TextDecoder", { value: undefined, configurable: true });
    Object.defineProperty(globalThis, "structuredClone", { value: undefined, configurable: true });
    const text = "中文 👩🏽‍💻\n".repeat(10000);
    expect(decodeUtf8(new TextEncoder().encode(text))).toBe(text);
    for (const bytes of [[0xc0,0x80],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xe4,0xb8]])
      expect(() => decodeUtf8(Uint8Array.from(bytes))).toThrow("UTF-8");
    const source = { nested: { n: 1 } }, copy = cloneProtocolState(source);
    copy.nested.n = 2; expect(source.nested.n).toBe(1);
  } finally {
    Object.defineProperty(globalThis, "TextDecoder", { value: decoder, configurable: true });
    Object.defineProperty(globalThis, "structuredClone", { value: clone, configurable: true });
  }
});
