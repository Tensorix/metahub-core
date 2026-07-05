// Keyboard routing convention for the WebUI.
//
// Two-sided contract (defense in depth):
//   • CONSUMERS of a key (chrome bars, void islands, menus) seal the event with
//     `consumeKey` — preventDefault so outer listeners can see it was handled,
//     AND stopPropagation so listeners we don't control (e.g. the quicknote
//     window's Escape-hides handler) never fire on a consumed key. CM6's own
//     keymap preventDefaults but does NOT stopPropagation, which is why…
//   • OUTER window/document listeners must check `e.defaultPrevented` (and
//     `imeGhost` — IME candidate-window keys are not app shortcuts) before
//     acting on a bubbled key.

/** Mark a keyboard event fully handled: nothing above us may act on it. */
export function consumeKey(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/** True while the key event belongs to an IME composition (candidate confirm /
 *  navigation). 229 is the legacy "composition in progress" keyCode some
 *  browsers still report on the trailing keydown. */
export function imeGhost(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
