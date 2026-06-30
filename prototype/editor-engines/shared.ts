import { createCm6Editor } from "./cm6-editor.ts";
import { createProseMirrorEditor } from "./pm-editor.ts";
import { MANUAL_CHECKLIST, SAMPLE_MARKDOWN } from "./samples.ts";

export type EngineId = "cm6" | "pm";

export interface SelfTestResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RoundTripStatus {
  kind: "exact" | "normalized" | "risk" | "not-applicable";
  label: string;
  detail: string;
}

export interface EditorAdapter {
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  setSyntaxVisible: (visible: boolean) => void;
  runSelfTest: () => SelfTestResult[];
  getRoundTripStatus: () => RoundTripStatus;
  destroy: () => void;
}

export interface EditorMountOptions {
  initialMarkdown: string;
  syntaxVisible: boolean;
  onChange: (markdown: string) => void;
}

type EditorFactory = (host: HTMLElement, options: EditorMountOptions) => EditorAdapter;

const factories: Record<EngineId, EditorFactory> = {
  cm6: createCm6Editor,
  pm: createProseMirrorEditor,
};

const engineLabels: Record<EngineId, { title: string; note: string }> = {
  cm6: {
    title: "CM6 Block Markdown",
    note: "Single flat Markdown document with block UI decorations.",
  },
  pm: {
    title: "ProseMirror Markdown",
    note: "Runtime doc tree, Markdown parser and serializer as the only persistence format.",
  },
};

const host = mustGet("editor-host");
const output = mustGet("markdown-output") as HTMLTextAreaElement;
const initialMarkdown = mustGet("initial-markdown");
const markdownStatus = mustGet("markdown-status");
const roundTripStatus = mustGet("roundtrip-value");
const roundTripLabel = mustGet("roundtrip-label");
const roundTripContainer = document.querySelector(".roundtrip-status") as HTMLElement;
const engineTitle = mustGet("engine-title");
const engineNote = mustGet("engine-note");
const checklist = mustGet("checklist");
const testSummary = mustGet("test-summary");
const selfTestResults = mustGet("self-test-results");
const cm6Tab = mustGet("cm6-tab") as HTMLButtonElement;
const pmTab = mustGet("pm-tab") as HTMLButtonElement;
const resetButton = mustGet("reset-button") as HTMLButtonElement;
const copyButton = mustGet("copy-button") as HTMLButtonElement;
const themeButton = mustGet("theme-button") as HTMLButtonElement;
const syntaxButton = mustGet("syntax-button") as HTMLButtonElement;
const selfTestButton = mustGet("self-test-button") as HTMLButtonElement;

let currentEngine: EngineId = "cm6";
let adapter: EditorAdapter | undefined;
let syntaxVisible = true;
let lastMarkdown = SAMPLE_MARKDOWN;

output.readOnly = true;
initialMarkdown.textContent = SAMPLE_MARKDOWN;
renderChecklist();
mountEngine(currentEngine, SAMPLE_MARKDOWN);

cm6Tab.addEventListener("click", () => mountEngine("cm6", lastMarkdown));
pmTab.addEventListener("click", () => mountEngine("pm", lastMarkdown));

resetButton.addEventListener("click", () => {
  adapter?.setMarkdown(SAMPLE_MARKDOWN);
  updateMarkdown(SAMPLE_MARKDOWN);
  renderSelfTestResults([]);
});

copyButton.addEventListener("click", async () => {
  const markdown = adapter?.getMarkdown() ?? output.value;
  try {
    await navigator.clipboard.writeText(markdown);
    markdownStatus.textContent = "Copied";
  } catch {
    output.focus();
    output.select();
    document.execCommand("copy");
    output.setSelectionRange(0, 0);
    markdownStatus.textContent = "Copied with fallback";
  }
});

themeButton.addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
});

syntaxButton.addEventListener("click", () => {
  syntaxVisible = !syntaxVisible;
  adapter?.setSyntaxVisible(syntaxVisible);
  host.classList.toggle("syntax-hidden", !syntaxVisible);
  syntaxButton.textContent = syntaxVisible ? "Syntax" : "Plain";
});

selfTestButton.addEventListener("click", () => {
  const results = adapter?.runSelfTest() ?? [];
  renderSelfTestResults(results);
});

function mountEngine(engine: EngineId, markdown: string): void {
  adapter?.destroy();
  host.replaceChildren();
  host.classList.toggle("syntax-hidden", !syntaxVisible);
  currentEngine = engine;
  const meta = engineLabels[engine];
  engineTitle.textContent = meta.title;
  engineNote.textContent = meta.note;
  updateTabs(engine);

  adapter = factories[engine](host, {
    initialMarkdown: markdown,
    syntaxVisible,
    onChange: updateMarkdown,
  });
  updateMarkdown(adapter.getMarkdown());
  renderSelfTestResults([]);
}

function updateMarkdown(markdown: string): void {
  lastMarkdown = markdown;
  output.value = markdown;
  markdownStatus.textContent = `${markdown.length.toLocaleString()} chars`;
  renderRoundTrip(adapter?.getRoundTripStatus());
}

function updateTabs(engine: EngineId): void {
  const pairs: Array<[EngineId, HTMLButtonElement]> = [
    ["cm6", cm6Tab],
    ["pm", pmTab],
  ];

  for (const [id, button] of pairs) {
    const active = id === engine;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function renderRoundTrip(status?: RoundTripStatus): void {
  const state = status ?? {
    kind: "not-applicable" as const,
    label: "Round-trip",
    detail: "No adapter mounted",
  };
  roundTripLabel.textContent = state.label;
  roundTripStatus.textContent = state.detail;
  roundTripContainer.className = "roundtrip-status";
  if (state.kind === "exact") {
    roundTripContainer.classList.add("is-ok");
  } else if (state.kind === "normalized") {
    roundTripContainer.classList.add("is-normalized");
  } else if (state.kind === "risk") {
    roundTripContainer.classList.add("is-risk");
  }
}

function renderChecklist(): void {
  checklist.replaceChildren(
    ...MANUAL_CHECKLIST.map((item, index) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      const span = document.createElement("span");
      input.type = "checkbox";
      input.id = `manual-check-${index}`;
      span.textContent = item;
      label.append(input, span);
      return label;
    }),
  );
}

function renderSelfTestResults(results: SelfTestResult[]): void {
  selfTestResults.replaceChildren();
  if (results.length === 0) {
    testSummary.textContent = "Not run";
    return;
  }

  const passCount = results.filter((result) => result.passed).length;
  testSummary.textContent = `${passCount}/${results.length} pass`;

  for (const result of results) {
    const item = document.createElement("div");
    item.className = `self-test-item ${result.passed ? "pass" : "fail"}`;
    item.textContent = `${result.passed ? "PASS" : "FAIL"} - ${result.name}: ${result.detail}`;
    selfTestResults.append(item);
  }
}

function mustGet(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element;
}
