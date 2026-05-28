import { test, expect } from "bun:test";
import { resolveEditorCommand } from "./editor.ts";

test("--vscode resolves to code --wait", () => {
  expect(resolveEditorCommand({ vscode: true }, {})).toBe("code --wait");
});

test("--editor maps a known name to its wait invocation", () => {
  expect(resolveEditorCommand({ editor: "zed" }, {})).toBe("zed --wait");
  expect(resolveEditorCommand({ editor: "nvim" }, {})).toBe("nvim");
});

test("--editor name lookup is case-insensitive and trimmed", () => {
  expect(resolveEditorCommand({ editor: "  VSCode " }, {})).toBe("code --wait");
});

test("--editor passes an unknown value through verbatim", () => {
  expect(resolveEditorCommand({ editor: "my-ed -w" }, {})).toBe("my-ed -w");
});

test("falls back to $EDITOR then $VISUAL then vi", () => {
  expect(resolveEditorCommand({}, { EDITOR: "nano" })).toBe("nano");
  expect(resolveEditorCommand({}, { VISUAL: "emacs" })).toBe("emacs");
  expect(resolveEditorCommand({}, {})).toBe("vi");
});

test("explicit flags beat env vars", () => {
  expect(resolveEditorCommand({ vscode: true }, { EDITOR: "nano" })).toBe("code --wait");
  expect(resolveEditorCommand({ editor: "zed" }, { EDITOR: "nano" })).toBe("zed --wait");
});
