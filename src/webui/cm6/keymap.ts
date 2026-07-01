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
} from "./structure";

export function structureKeymap(opts: { onExitTop?: () => void } = {}): Extension {
  return Prec.highest(
    keymap.of([
      { key: "Enter", run: enterCommand },
      { key: "Backspace", run: backspaceCommand },
      { key: "Tab", run: indentCommand, shift: outdentCommand },
      { key: "Home", run: smartHome },
      { key: "Mod-ArrowLeft", run: smartHome },
      { key: "ArrowUp", run: makeExitTop(opts.onExitTop) },
    ]),
  );
}
