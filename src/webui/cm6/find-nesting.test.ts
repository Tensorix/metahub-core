// Find-highlight nesting contract (see findField's `provide` in chrome/find.tsx).
//
// In CM6 the DOM nesting of mark decorations IS the decoration-source
// precedence: the highest-precedence mark ends up INNERMOST, so it paints last.
// The find highlight must therefore outrank the rich layer's inline marks —
// otherwise a match inside `` `code` `` renders as
// `<span class="cm-find-cur"><span class="cm-code">` and the chip's opaque
// background eats the accent fill while cm-find-cur's `color` still inherits
// down: white glyphs on a pale grey chip, i.e. invisible.
//
// Mounting a real EditorView needs a DOM; register happy-dom for this file only
// (bun test shares one process — a leaked global `document` breaks turndown in
// html-md.test.ts) and import the CM6 modules after registration.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { baseExtensions } = await import("./editor-view.ts");
const { find, openFind, setFind } = await import("./chrome/find.tsx");

afterAll(() => GlobalRegistrator.unregister());

/** Mount the real editor stack (same extension order as CmDocBody) and search. */
function mount(doc: string, term: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [...baseExtensions({ onExitTop: () => {} }), find()],
    }),
  });
  view.dispatch({ effects: openFind.of(null) });
  view.dispatch({ effects: setFind.of({ term }) });
  return view;
}

test("a match inside inline code nests INSIDE .cm-code (highlight paints over the chip)", () => {
  const view = mount("see the `Laplace` chip\n", "Laplace");
  const content = view.contentDOM;
  expect(content.querySelector(".cm-code > .cm-find")).not.toBeNull();
  expect(content.querySelector(".cm-find .cm-code")).toBeNull();
  // The current match carries both classes, on the innermost span.
  expect(content.querySelector(".cm-code > .cm-find.cm-find-cur")?.textContent).toBe("Laplace");
  view.destroy();
});

test("a match inside a link nests INSIDE .cm-link (accent-on-accent text would be invisible)", () => {
  const view = mount("see [Laplace](https://e.com) here\n", "Laplace");
  const content = view.contentDOM;
  expect(content.querySelector(".cm-link > .cm-find")).not.toBeNull();
  expect(content.querySelector(".cm-find .cm-link")).toBeNull();
  view.destroy();
});

test("plain-prose matches still paint (no rich mark involved)", () => {
  const view = mount("plain Laplace text\n", "Laplace");
  expect(view.contentDOM.querySelector(".cm-find.cm-find-cur")?.textContent).toBe("Laplace");
  view.destroy();
});
