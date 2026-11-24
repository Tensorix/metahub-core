import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { docModel, docModelField } = await import("../doc-model");
const { slashMenu } = await import("./slash-menu");
const { blocksFromBody } = await import("../../blocks");
afterAll(() => GlobalRegistrator.unregister());

test("/mermaid inserts a fenced diagram and preserves its containing list", () => {
  const view = new EditorView({ state: EditorState.create({
    doc: "- Plan\n  ", selection: { anchor: 9 }, extensions: [docModelField, slashMenu()],
  }), parent: document.body });
  try {
    view.dispatch(view.state.replaceSelection("/mermaid"));
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    const diagram = docModel(view.state).voids[0]!;
    expect(diagram.kind).toBe("code");
    expect(diagram.block.lang).toBe("mermaid");
    const parent = blocksFromBody(view.state.doc.toString())[0]!;
    expect(parent.content).toBe("Plan");
    expect(parent.children?.[0]?.content).toContain("flowchart LR");
    expect(parent.children?.[0]?.content).toContain("-->");
    expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from + 2);
  } finally {
    view.destroy();
  }
});
