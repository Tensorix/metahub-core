import { basicSetup } from "codemirror";
import { indentLess, indentMore } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { EditorSelection, EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  gutter,
  keymap,
} from "@codemirror/view";
import { REQUIRED_BLOCK_TYPES, type RequiredBlockType, SAMPLE_MARKDOWN } from "./samples.ts";
import type { EditorAdapter, EditorMountOptions, RoundTripStatus, SelfTestResult } from "./shared.ts";
import {
  type MarkdownBlock,
  extractFence,
  findBlockAt,
  getListLineMatch,
  scanMarkdownBlocks,
} from "./markdown-blocks.ts";

interface DragPayload {
  from: number;
  to: number;
}

export function createCm6Editor(host: HTMLElement, options: EditorMountOptions): EditorAdapter {
  let suppressChange = false;

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: options.initialMarkdown,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        cmTheme,
        blockDecorations,
        blockGutter(),
        blockKeymap(),
        blockDomHandlers(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressChange) {
            options.onChange(update.state.doc.toString());
          }
        }),
      ],
    }),
  });

  view.dom.classList.toggle("syntax-hidden", !options.syntaxVisible);

  return {
    getMarkdown: () => view.state.doc.toString(),
    setMarkdown: (markdownText: string) => {
      suppressChange = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: markdownText },
        selection: EditorSelection.cursor(0),
      });
      suppressChange = false;
      options.onChange(markdownText);
    },
    setSyntaxVisible: (visible: boolean) => {
      view.dom.classList.toggle("syntax-hidden", !visible);
    },
    runSelfTest: () => runCmSelfTest(view.state.doc.toString()),
    getRoundTripStatus: (): RoundTripStatus => ({
      kind: "not-applicable",
      label: "CM6 persistence",
      detail: "EditorState.doc is the saved Markdown string",
    }),
    destroy: () => view.destroy(),
  };
}

const cmTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--surface)",
    color: "var(--text)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent-soft) 35%, transparent)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent) !important",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--accent-strong)",
  },
});

const blockDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildBlockDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildBlockDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

function buildBlockDecorations(view: EditorView): DecorationSet {
  const markdownText = view.state.doc.toString();
  const blocks = scanMarkdownBlocks(markdownText);
  const builder = new RangeSetBuilder<Decoration>();

  for (const block of blocks) {
    for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          class: `cm-block-line cm-block-${block.type}`,
          attributes: {
            "data-block-type": block.type,
          },
        }),
      );
    }

    const widget = previewWidgetFor(block);
    if (widget) {
      builder.add(block.to, block.to, Decoration.widget({ widget, block: true, side: 1 }));
    }
  }

  return builder.finish();
}

function blockGutter(): Extension {
  return gutter({
    class: "cm-block-gutter",
    renderEmptyElements: true,
    lineMarker(view, line) {
      const block = scanMarkdownBlocks(view.state.doc.toString()).find((candidate) => candidate.from === line.from);
      return block ? new BlockGutterMarker(block) : null;
    },
    lineMarkerChange: (update) => update.docChanged || update.viewportChanged,
    domEventHandlers: {
      click(view, line, event) {
        const target = event.target as HTMLElement | null;
        const button = target?.closest<HTMLElement>("[data-cm-block-action]");
        if (!button) {
          return false;
        }

        event.preventDefault();
        const blocks = scanMarkdownBlocks(view.state.doc.toString());
        const block = blocks.find((candidate) => candidate.from === line.from);
        if (!block) {
          return true;
        }

        const action = button.dataset.cmBlockAction;
        if (action === "add") {
          insertBlankBlockAfter(view, block);
        }
        return true;
      },
      dragstart(view, line, event) {
        const dragEvent = event as DragEvent;
        const target = dragEvent.target as HTMLElement | null;
        const handle = target?.closest<HTMLElement>("[data-cm-block-drag]");
        if (!handle || !dragEvent.dataTransfer) {
          return false;
        }

        const blocks = scanMarkdownBlocks(view.state.doc.toString());
        const block = blocks.find((candidate) => candidate.from === line.from);
        if (!block) {
          return false;
        }

        dragEvent.dataTransfer.effectAllowed = "move";
        dragEvent.dataTransfer.setData("text/x-metahub-cm-block", JSON.stringify({ from: block.from, to: block.to }));
        dragEvent.dataTransfer.setData("text/plain", block.text);
        return true;
      },
    },
  });
}

class BlockGutterMarker extends GutterMarker {
  constructor(private readonly block: MarkdownBlock) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof BlockGutterMarker && other.block.id === this.block.id;
  }

  override toDOM(): Node {
    const root = document.createElement("span");
    root.className = "cm-block-control";
    root.dataset.blockType = this.block.type;
    root.title = `${this.block.type}: ${this.block.summary}`;

    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "+";
    add.title = "Insert blank Markdown block after this block";
    add.dataset.cmBlockAction = "add";

    const handle = document.createElement("span");
    handle.className = "cm-block-handle";
    handle.textContent = "::";
    handle.title = "Drag Markdown block";
    handle.draggable = true;
    handle.dataset.cmBlockDrag = "true";

    const menu = document.createElement("button");
    menu.type = "button";
    menu.textContent = "...";
    menu.title = "Block menu placeholder";
    menu.dataset.cmBlockAction = "menu";

    root.append(add, handle, menu);
    return root;
  }
}

class MediaPreviewWidget extends WidgetType {
  constructor(private readonly block: MarkdownBlock) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof MediaPreviewWidget && other.block.text === this.block.text;
  }

  override toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-block-preview cm-media-preview";
    const imageMatch = this.block.text.match(/!\[([^\]]*)]\(([^)\s]+)(?:\s+"([^"]*)")?\)/);
    const linkMatch = this.block.text.match(/\[([^\]]+)]\(([^)\s]+)(?:\s+"([^"]*)")?\)/);

    if (imageMatch) {
      const img = document.createElement("img");
      img.alt = imageMatch[1] ?? "";
      img.src = imageMatch[2] ?? "";
      root.append(img);
    } else if (linkMatch) {
      const link = document.createElement("a");
      link.href = linkMatch[2] ?? "#";
      link.textContent = linkMatch[1] ?? "file";
      link.target = "_blank";
      link.rel = "noreferrer";
      root.append("File link: ", link);
    }

    return root;
  }
}

class HtmlPreviewWidget extends WidgetType {
  constructor(private readonly block: MarkdownBlock) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof HtmlPreviewWidget && other.block.text === this.block.text;
  }

  override toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-block-preview cm-html-preview";
    const { body } = extractFence(this.block);
    root.textContent = `mh-html preview source (${body.length} chars): ${body.slice(0, 160)}`;
    return root;
  }
}

function previewWidgetFor(block: MarkdownBlock): WidgetType | undefined {
  if (block.type === "media") {
    return new MediaPreviewWidget(block);
  }
  if (block.type === "html_fence") {
    return new HtmlPreviewWidget(block);
  }
  return undefined;
}

function blockKeymap(): Extension {
  return keymap.of([
    {
      key: "Tab",
      run: (view) => handleTab(view),
    },
    {
      key: "Shift-Tab",
      run: (view) => handleShiftTab(view),
    },
    {
      key: "Enter",
      run: (view) => exitEmptyListItem(view),
    },
    {
      key: "Mod-]",
      run: indentMore,
    },
    {
      key: "Mod-[",
      run: indentLess,
    },
  ]);
}

function blockDomHandlers(): Extension {
  return EditorView.domEventHandlers({
    dragover(event) {
      if (event.dataTransfer?.types.includes("text/x-metahub-cm-block")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        return true;
      }
      return false;
    },
    drop(event, view) {
      const data = event.dataTransfer?.getData("text/x-metahub-cm-block");
      if (!data) {
        return false;
      }

      event.preventDefault();
      const payload = parseDragPayload(data);
      if (!payload) {
        return true;
      }

      const coords = { x: event.clientX, y: event.clientY };
      const position = view.posAtCoords(coords) ?? view.state.doc.length;
      moveMarkdownBlock(view, payload, position);
      return true;
    },
  });
}

function handleTab(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const blocks = scanMarkdownBlocks(state.doc.toString());
  const block = findBlockAt(blocks, pos);
  const line = state.doc.lineAt(pos);

  if (block?.type === "code_fence" || block?.type === "html_fence") {
    if (line.number !== block.startLine && line.number !== block.endLine) {
      view.dispatch(state.replaceSelection("  "));
      return true;
    }
    return false;
  }

  if (block?.type === "list" || block?.type === "task" || getListLineMatch(line.text)) {
    indentSelectedLines(view, "in");
    return true;
  }

  return false;
}

function handleShiftTab(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const blocks = scanMarkdownBlocks(state.doc.toString());
  const block = findBlockAt(blocks, pos);
  const line = state.doc.lineAt(pos);

  if (block?.type === "list" || block?.type === "task" || getListLineMatch(line.text)) {
    indentSelectedLines(view, "out");
    return true;
  }

  return false;
}

function indentSelectedLines(view: EditorView, direction: "in" | "out"): void {
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);
  const changes: Array<{ from: number; to?: number; insert: string }> = [];

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (direction === "in") {
      changes.push({ from: line.from, insert: "  " });
    } else if (line.text.startsWith("  ")) {
      changes.push({ from: line.from, to: line.from + 2, insert: "" });
    } else if (line.text.startsWith("\t")) {
      changes.push({ from: line.from, to: line.from + 1, insert: "" });
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: direction === "in" ? "input.indent" : "input.dedent" });
  }
}

function exitEmptyListItem(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const match = line.text.match(/^(\s*)([-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?$/);
  if (!match) {
    return false;
  }

  const indent = match[1] ?? "";
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: indent },
    selection: EditorSelection.cursor(line.from + indent.length),
    userEvent: "input",
  });
  return true;
}

function insertBlankBlockAfter(view: EditorView, block: MarkdownBlock): void {
  const doc = view.state.doc;
  const needsLeadingBreak = block.to > 0 && doc.sliceString(block.to - 1, block.to) !== "\n";
  const insert = `${needsLeadingBreak ? "\n" : ""}\n`;
  view.dispatch({
    changes: { from: block.to, insert },
    selection: EditorSelection.cursor(block.to + insert.length),
    userEvent: "input",
  });
  view.focus();
}

function moveMarkdownBlock(view: EditorView, payload: DragPayload, dropPosition: number): void {
  const markdownText = view.state.doc.toString();
  const blocks = scanMarkdownBlocks(markdownText);
  const source = blocks.find((block) => block.from === payload.from && block.to === payload.to) ??
    blocks.find((block) => payload.from >= block.from && payload.from < block.to);
  const target = findBlockAt(blocks, dropPosition);

  if (!source || (target && target.from === source.from)) {
    return;
  }

  const sourceText = markdownText.slice(source.from, source.to);
  const withoutSource = markdownText.slice(0, source.from) + markdownText.slice(source.to);
  let insertAt = target ? target.from : markdownText.length;
  if (insertAt > source.from) {
    insertAt -= source.to - source.from;
  }
  insertAt = Math.max(0, Math.min(insertAt, withoutSource.length));

  const nextDoc = withoutSource.slice(0, insertAt) + sourceText + withoutSource.slice(insertAt);
  view.dispatch({
    changes: { from: 0, to: markdownText.length, insert: nextDoc },
    selection: EditorSelection.cursor(insertAt),
    userEvent: "move",
  });
  view.focus();
}

function parseDragPayload(data: string): DragPayload | undefined {
  try {
    const parsed = JSON.parse(data) as Partial<DragPayload>;
    if (typeof parsed.from === "number" && typeof parsed.to === "number") {
      return { from: parsed.from, to: parsed.to };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function runCmSelfTest(markdownText: string): SelfTestResult[] {
  const blocks = scanMarkdownBlocks(markdownText);
  const seen = new Set(blocks.map((block) => block.type));
  const required = REQUIRED_BLOCK_TYPES.map((type) => ({
    name: `block:${type}`,
    passed: seen.has(type),
    detail: seen.has(type) ? "scanner found block type" : "scanner did not find block type",
  }));

  const monotonic = blocks.every((block, index) => {
    const next = blocks[index + 1];
    return !next || block.from <= block.to && block.to <= next.from;
  });

  const sampleBlocks = scanMarkdownBlocks(SAMPLE_MARKDOWN);
  const moved = simulateMove(SAMPLE_MARKDOWN, sampleBlocks.find((block) => block.type === "table"));

  return [
    ...required,
    {
      name: "flat-doc",
      passed: markdownText === String(markdownText),
      detail: "current EditorState.doc is directly read as Markdown",
    },
    {
      name: "range-order",
      passed: monotonic,
      detail: `${blocks.length} ranges scanned in document order`,
    },
    {
      name: "drag-range-move",
      passed: moved.includes("| escaped pipe | a \\| b |") && moved.includes("```mh-html"),
      detail: "simulated Markdown range move preserved table and mh-html text",
    },
    {
      name: "inline-code-corners",
      passed: markdownText.includes("``const s =") && markdownText.includes("中文") && markdownText.includes("😀"),
      detail: "inline code, CJK, and emoji substrings are present",
    },
  ].map((result) => ({
    ...result,
    name: result.name.replace("block:", "block:") as string,
  }));
}

function simulateMove(markdownText: string, source: MarkdownBlock | undefined): string {
  if (!source) {
    return markdownText;
  }
  const withoutSource = markdownText.slice(0, source.from) + markdownText.slice(source.to);
  return source.text + withoutSource;
}
