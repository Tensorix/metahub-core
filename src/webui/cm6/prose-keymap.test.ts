import { describe, test, expect } from "bun:test";
import { defaultKeymap } from "@codemirror/commands";
import { APP_RESERVED_KEYS, proseDefaultKeymap } from "./prose-keymap";

describe("proseDefaultKeymap", () => {
  test("upstream still binds the keys we strip (else the filter is stale)", () => {
    for (const k of APP_RESERVED_KEYS) expect(defaultKeymap.some((b) => b.key === k)).toBe(true);
  });
  test("app navigation keys are not bound by the editor", () => {
    for (const k of APP_RESERVED_KEYS) expect(proseDefaultKeymap.some((b) => b.key === k)).toBe(false);
  });
  test("only those bindings are removed", () => {
    expect(defaultKeymap.length - proseDefaultKeymap.length).toBe(APP_RESERVED_KEYS.length);
  });
});
