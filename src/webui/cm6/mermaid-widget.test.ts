import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { baseExtensions } = await import("./editor-view");
afterAll(() => GlobalRegistrator.unregister());

const example = "flowchart LR\n  A[Draft] --> B[Publish]";
const plain = "\n```js\nconst label = 'Publish';\n```";
const fixture = (diagram: string) => "```mermaid\n" + diagram + "\n```" + plain;

function mount() {
  return new EditorView({ parent: document.body, state: EditorState.create({
    doc: fixture(example), extensions: baseExtensions({}),
  }) });
}

async function until(check: () => boolean) {
  const end = Date.now() + 1500;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("editing a diagram updates its Markdown and preview, and undo returns to the same source editor", async () => {
  const view = mount();
  const preview = () => view.dom.querySelector(".mermaid-preview svg")?.textContent ?? "";
  const input = () => view.dom.querySelector<HTMLTextAreaElement>(".mermaid-source textarea");
  try {
    await until(() => preview().includes("Publish"));
    // happy-dom has no layout. Pele defers redraw for a connected zero-width
    // host, so give the actual preview a visible viewport.
    Object.defineProperty(view.dom.querySelector(".mermaid-preview")!, "clientWidth", { value: 640 });
    expect(input()).toBeNull();
    view.dom.querySelector<HTMLButtonElement>(".mermaid-edit")!.click();
    await until(() => input()?.value === example);

    const changed = example.replace("Publish", "Review");
    const ta = input()!;
    ta.value = changed;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.state.doc.toString()).toBe(fixture(changed));
    await until(() => preview().includes("Review"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe(fixture(example));
    await until(() => input()?.value === example && preview().includes("Publish"));
    expect(document.activeElement).toBe(input());
    expect(view.dom.querySelector<HTMLTextAreaElement>(".codeblock textarea")?.value).toBe("const label = 'Publish';");
  } finally { view.destroy(); }
});

test("a focused diagram rebuilt after an external edit reads the new Markdown", async () => {
  const view = mount();
  try {
    view.dom.querySelector<HTMLButtonElement>(".mermaid-edit")!.click();
    const oldInput = view.dom.querySelector<HTMLTextAreaElement>(".mermaid-source textarea")!;
    await until(() => oldInput.value === example);
    const from = view.state.doc.toString().indexOf("Publish");
    view.dispatch({ changes: { from, to: from + "Publish".length, insert: "Archive" } });
    await until(() => view.dom.querySelector(".mermaid-preview svg")?.textContent?.includes("Archive") === true);
    expect(oldInput.isConnected).toBe(false);
    view.dom.querySelector<HTMLButtonElement>(".mermaid-edit")!.click();
    const newInput = view.dom.querySelector<HTMLTextAreaElement>(".mermaid-source textarea")!;
    await until(() => newInput.value === example.replace("Publish", "Archive"));
    expect(view.state.doc.toString()).toBe(fixture(newInput.value));
  } finally { view.destroy(); }
});
