// Load-time healing of LEGACY empty-todo lines.
//
// The strict line grammar (blocks.ts) requires whitespace after a todo's `]`:
// `- [ ] ` is an empty todo, a bare `- [ ]` is a bullet whose content is the
// literal `[ ]`. Bodies written before the tightening (the old lenient regex
// accepted `- [ ]` as a todo) can therefore contain empty todos WITHOUT the
// trailing space — which now render as `• [ ]` garbage on every surface.
//
// `healLegacyTodoLines` restores the serializer's canonical form by appending
// the missing space. It is deliberately narrow:
//   • only lines that END at the `]` (an empty todo) — `- [ ]x` and other
//     bullet content stays untouched, the grammar itself is NOT relaxed;
//   • never inside a void (a fenced code/html block or table may legally
//     contain such text) — the shared scanner decides, so the heal can't
//     disagree with what renders;
//   • idempotent, applied at the editor boundary only (CmDocBody load / remote
//     setDoc — the same seam as stripStaleUploadLines). Mid-typing text is
//     never touched: keystrokes don't pass through this function.

import { scanDoc } from "./blockmodel";

/** `- [ ]` / `- [x]` (any list glyph, any indent) with nothing after the `]`. */
const LEGACY_EMPTY_TODO = /^[ \t]*[-*+][ \t]+\[[ xX]\]$/;

export function healLegacyTodoLines(src: string): string {
  // Fast path: no line ends in a checkbox bracket → nothing to heal.
  if (!/\[[ xX]\]$/m.test(src)) return src;
  const model = scanDoc(src);
  let changed = false;
  const lines = model.lines.map((li) => {
    if (li.role !== "void" && LEGACY_EMPTY_TODO.test(li.text)) {
      changed = true;
      return li.text + " ";
    }
    return li.text;
  });
  return changed ? lines.join("\n") : src;
}
