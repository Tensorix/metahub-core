// Plain-text discipline for the title-shaped contentEditable surfaces (doc
// title, database name, record peek heading).
//
// Those hosts store a plain string — their onInput/onBlur read textContent —
// but a bare contentEditable lets the browser insert the clipboard's text/html
// verbatim on paste or drop. The pasted <span style="font-size:11pt">/<font>
// children then win over the host's own CSS font-size (inline styles beat a
// class selector, and font-size inherits), so the title visibly shrinks to
// whatever the source app used. Word/Excel/Numbers flavors can even carry a
// <style> element, whose rules apply document-wide once it lands in the page.
//
// The fix is to never let markup in: take text/plain, insert it as text.

export interface PlainEditOpts {
  /** Keep newlines instead of folding them into single spaces. Default: fold. */
  multiline?: boolean;
}

/**
 * The plain-text payload of a clipboard/drag transfer, normalized for a
 * single-line host: CRLF folded to LF, then (unless `multiline`) every run of
 * newlines collapsed to one space so a pasted paragraph can't smuggle a "\n"
 * into a one-line title.
 */
export function plainTextFrom(dt: DataTransfer | null | undefined, opts: PlainEditOpts = {}): string {
  const raw = dt?.getData("text/plain") ?? "";
  const text = raw.replace(/\r\n?/g, "\n");
  if (opts.multiline) return text;
  return text.replace(/[ \t]*\n[ \t]*/g, " ").trim();
}

/**
 * Insert `text` at the caret. execCommand("insertText") is deprecated but is
 * still the only insertion that participates in the browser's native undo
 * stack for contentEditable; fall back to a Range edit where it's unavailable.
 */
export function insertPlainText(text: string): void {
  if (!text) return;
  try {
    if (document.execCommand("insertText", false, text)) return;
  } catch {
    // execCommand is absent (or threw) — fall through to the Range path.
  }
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Collapse a host back to a single text node, caret at the end. Safety net for
 * the injection paths we don't intercept (spellcheck replacement, extensions,
 * autofill) — the handlers below cover paste and drop.
 */
export function flattenToText(el: HTMLElement): void {
  if (!el.firstElementChild) return;
  const text = el.textContent ?? "";
  el.textContent = text;
  if (document.activeElement !== el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Move the caret to the document position under (x, y), if the engine can. */
function caretTo(x: number, y: number): void {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let range: Range | null = null;
  if (doc.caretRangeFromPoint) range = doc.caretRangeFromPoint(x, y);
  else if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range) return;
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * `{...plainPasteHandlers()}` on a contentEditable host: paste and drop both
 * insert plain text only. Drop matters as much as paste — dragging a selection
 * from another page is the same markup-injection path.
 */
export function plainPasteHandlers(opts: PlainEditOpts = {}) {
  return {
    onPaste: (e: ClipboardEvent) => {
      e.preventDefault();
      insertPlainText(plainTextFrom(e.clipboardData, opts));
    },
    onDrop: (e: DragEvent) => {
      const text = plainTextFrom(e.dataTransfer, opts);
      if (!text) return; // a file drop: leave it to whoever handles files
      e.preventDefault();
      // The caret hasn't moved to the drop point yet — place it there, else the
      // text lands wherever the selection happened to be.
      caretTo(e.clientX, e.clientY);
      insertPlainText(text);
    },
  };
}
