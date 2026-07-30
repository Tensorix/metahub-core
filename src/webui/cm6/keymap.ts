// The structure keymap, at the highest precedence so it preempts the default and
// history keymaps. Every binding delegates to a pure command in structure.ts and
// returns false to fall through when it has nothing to do.

import { keymap } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import {
  enterCommand,
  backspaceCommand,
  indentCommand,
  outdentCommand,
  smartHome,
  makeExitTop,
  makeMergeTop,
  makeVoidExit,
  arrowIntoCodeBelow,
  arrowIntoCodeAbove,
} from "./structure";
import { duplicateBlock, selectStaged } from "./block-range";

export function structureKeymap(
  opts: { onExitTop?: () => void; onMergeTop?: (text: string) => boolean } = {},
): Extension {
  return Prec.highest(
    keymap.of([
      { key: "Enter", run: enterCommand },
      { key: "Backspace", run: backspaceCommand },
      // At the very start of the document the "block above" is the title — merge
      // into it (the delete-direction counterpart of the ArrowUp handoff below).
      // backspaceCommand always declines at offset 0, so the two never compete.
      { key: "Backspace", run: makeMergeTop(opts.onMergeTop) },
      { key: "Tab", run: indentCommand, shift: outdentCommand },
      { key: "Home", run: smartHome },
      { key: "Mod-ArrowLeft", run: smartHome },
      // exitTop first: it only fires on the document's FIRST visual row, where no
      // code void can sit above the caret, so the two never compete.
      { key: "ArrowUp", run: makeExitTop(opts.onExitTop) },
      // Code voids are atomic; these hand focus into the island's textarea when
      // vertical motion would otherwise skip over the whole block.
      { key: "ArrowUp", run: arrowIntoCodeAbove },
      { key: "ArrowDown", run: arrowIntoCodeBelow },
      // A SELECTED void (accent ring): arrows step off it to the adjacent line —
      // the default motions strand the caret on the void's atomic edge. These
      // fire only on a selection exactly covering a void, so they never compete
      // with the empty-caret bindings above.
      { key: "ArrowUp", run: makeVoidExit(-1) },
      { key: "ArrowLeft", run: makeVoidExit(-1) },
      { key: "ArrowDown", run: makeVoidExit(1) },
      { key: "ArrowRight", run: makeVoidExit(1) },
      // Duplicate the block at the caret (or the selection's line range). Lives
      // in the rich layer's keymap on purpose: source mode keeps the browser
      // default for Mod-d.
      { key: "Mod-d", run: duplicateBlock, preventDefault: true },
      // Staged select-all: block (incl. list subtree / void span) → whole doc.
      { key: "Mod-a", run: selectStaged, preventDefault: true },
    ]),
  );
}
