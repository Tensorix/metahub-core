import MarkdownIt from "markdown-it";
import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  deleteSelection,
  joinBackward,
  liftEmptyBlock,
  newlineInCode,
  selectNodeBackward,
  splitBlock,
} from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { type Mark, type MarkSpec, type Node as PMNode, type NodeSpec, Schema } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { columnResizing, tableEditing, tableNodes } from "prosemirror-tables";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { REQUIRED_BLOCK_TYPES, SAMPLE_MARKDOWN } from "./samples.ts";
import type { EditorAdapter, EditorMountOptions, RoundTripStatus, SelfTestResult } from "./shared.ts";
import {
  type MarkdownBlock,
  extractFence,
  getListLineMatch,
  scanMarkdownBlocks,
  splitTableRow,
} from "./markdown-blocks.ts";

interface ListTree {
  ordered: boolean;
  order: number;
  items: ListItemTree[];
}

interface ListItemTree {
  checked: boolean | null;
  text: string;
  children: ListTree[];
}

interface TopLevelNode {
  index: number;
  pos: number;
  node: PMNode;
}

const markdownIt = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
});

const tableSpecs = tableNodes({
  tableGroup: "block",
  cellContent: "paragraph+",
  cellAttributes: {},
});

export const pmSchema = new Schema({
  nodes: {
    doc: {
      content: "block+",
    },
    text: {
      group: "inline",
    },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    } satisfies NodeSpec,
    heading: {
      attrs: { level: { default: 1 } },
      content: "inline*",
      group: "block",
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        attrs: { level },
      })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    } satisfies NodeSpec,
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    } satisfies NodeSpec,
    horizontal_rule: {
      group: "block",
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["hr"],
    } satisfies NodeSpec,
    code_block: {
      attrs: { params: { default: "" } },
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: (node) => ["pre", ["code", { "data-language": node.attrs.params || "" }, 0]],
    } satisfies NodeSpec,
    mh_html: {
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      parseDOM: [{ tag: "pre[data-mh-html]", preserveWhitespace: "full" }],
      toDOM: () => ["pre", { class: "pm-mh-html", "data-mh-html": "true" }, ["code", 0]],
    } satisfies NodeSpec,
    bullet_list: {
      content: "(list_item | task_item)+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    } satisfies NodeSpec,
    ordered_list: {
      attrs: { order: { default: 1 } },
      content: "(list_item | task_item)+",
      group: "block",
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (dom) => ({
            order: dom instanceof HTMLOListElement && dom.hasAttribute("start") ? Number(dom.getAttribute("start")) : 1,
          }),
        },
      ],
      toDOM: (node) => (node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order }, 0]),
    } satisfies NodeSpec,
    list_item: {
      content: "paragraph block*",
      defining: true,
      parseDOM: [{ tag: "li:not([data-task])" }],
      toDOM: () => ["li", 0],
    } satisfies NodeSpec,
    task_item: {
      attrs: { checked: { default: false } },
      content: "paragraph block*",
      defining: true,
      parseDOM: [
        {
          tag: "li[data-task]",
          getAttrs: (dom) => ({
            checked: dom instanceof HTMLElement && dom.dataset.checked === "true",
          }),
        },
      ],
      toDOM: (node) => [
        "li",
        { "data-task": "true", "data-checked": String(Boolean(node.attrs.checked)) },
        0,
      ],
    } satisfies NodeSpec,
    image_block: {
      attrs: {
        src: {},
        alt: { default: "" },
        title: { default: "" },
      },
      group: "block",
      atom: true,
      draggable: true,
      selectable: true,
      toDOM: (node) => [
        "figure",
        { class: "pm-media-block" },
        ["img", { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title || null }],
        ["figcaption", node.attrs.alt || node.attrs.src],
      ],
    } satisfies NodeSpec,
    file_link: {
      attrs: {
        href: {},
        label: { default: "file" },
        title: { default: "" },
      },
      group: "block",
      atom: true,
      draggable: true,
      selectable: true,
      toDOM: (node) => [
        "a",
        {
          class: "pm-file-link",
          href: node.attrs.href,
          title: node.attrs.title || null,
          target: "_blank",
          rel: "noreferrer",
        },
        node.attrs.label,
      ],
    } satisfies NodeSpec,
    ...tableSpecs,
  },
  marks: {
    link: {
      attrs: {
        href: {},
        title: { default: null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom) => ({
            href: dom instanceof HTMLAnchorElement ? dom.getAttribute("href") : "",
            title: dom instanceof HTMLAnchorElement ? dom.getAttribute("title") : null,
          }),
        },
      ],
      toDOM: (mark) => [
        "a",
        {
          href: mark.attrs.href,
          title: mark.attrs.title,
          target: "_blank",
          rel: "noreferrer",
        },
        0,
      ],
    } satisfies MarkSpec,
    em: {
      parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0],
    } satisfies MarkSpec,
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }, { style: "font-weight=bold" }],
      toDOM: () => ["strong", 0],
    } satisfies MarkSpec,
    code: {
      code: true,
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", 0],
    } satisfies MarkSpec,
  },
});

export function createProseMirrorEditor(host: HTMLElement, options: EditorMountOptions): EditorAdapter {
  const wrapper = document.createElement("div");
  wrapper.className = "pm-editor";
  wrapper.classList.toggle("pm-syntax-hidden", !options.syntaxVisible);
  host.append(wrapper);

  let suppressChange = false;
  const initialSerialized = serializeMarkdown(parseMarkdownToDoc(options.initialMarkdown));

  const view = new EditorView(wrapper, {
    state: createPmState(options.initialMarkdown),
    dispatchTransaction(transaction) {
      const nextState = view.state.apply(transaction);
      view.updateState(nextState);
      if (!suppressChange) {
        options.onChange(serializeMarkdown(nextState.doc));
      }
    },
  });

  return {
    getMarkdown: () => serializeMarkdown(view.state.doc),
    setMarkdown: (markdownText: string) => {
      suppressChange = true;
      view.updateState(createPmState(markdownText));
      suppressChange = false;
      options.onChange(serializeMarkdown(view.state.doc));
    },
    setSyntaxVisible: (visible: boolean) => {
      wrapper.classList.toggle("pm-syntax-hidden", !visible);
    },
    runSelfTest: () => runPmSelfTest(view.state.doc),
    getRoundTripStatus: () => getPmRoundTripStatus(view.state.doc, options.initialMarkdown, initialSerialized),
    destroy: () => view.destroy(),
  };
}

function createPmState(markdownText: string): EditorState {
  return EditorState.create({
    schema: pmSchema,
    doc: parseMarkdownToDoc(markdownText),
    plugins: [
      history(),
      keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Shift-Mod-z": redo,
        Enter: chainCommands(
          newlineInCode,
          splitListItem(pmSchema.nodes.task_item),
          splitListItem(pmSchema.nodes.list_item),
          createParagraphNear,
          liftEmptyBlock,
          splitBlock,
        ),
        "Mod-Enter": chainCommands(exitCodeFallback, splitBlock),
        Backspace: chainCommands(deleteSelection, joinBackward, selectNodeBackward),
        Tab: chainCommands(sinkListItem(pmSchema.nodes.task_item), sinkListItem(pmSchema.nodes.list_item)),
        "Shift-Tab": chainCommands(liftListItem(pmSchema.nodes.task_item), liftListItem(pmSchema.nodes.list_item)),
      }),
      keymap(prototypeExtraKeymap()),
      keymap(baseKeymap),
      gapCursor(),
      dropCursor(),
      columnResizing(),
      tableEditing({ allowTableNodeSelection: true }),
      blockDragPlugin(),
    ],
  });
}

function prototypeExtraKeymap() {
  return {
    "Ctrl-h": joinBackward,
    "Alt-ArrowUp": liftListItem(pmSchema.nodes.list_item),
    "Alt-ArrowDown": sinkListItem(pmSchema.nodes.list_item),
  };
}

function exitCodeFallback(state: EditorState, dispatch?: (transaction: EditorState["tr"]) => void): boolean {
  const { $head } = state.selection;
  if (!$head.parent.type.spec.code) {
    return false;
  }
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(pmSchema.nodes.paragraph.create()).scrollIntoView());
  }
  return true;
}

export function parseMarkdownToDoc(markdownText: string): PMNode {
  const blocks = scanMarkdownBlocks(markdownText);
  const content = blocks.flatMap((block) => blockToPmNodes(block));
  return pmSchema.nodes.doc.create(null, content.length > 0 ? content : [emptyParagraph()]);
}

function blockToPmNodes(block: MarkdownBlock): PMNode[] {
  if (block.text.trim() === "") {
    return [emptyParagraph()];
  }

  switch (block.type) {
    case "heading": {
      const match = block.text.trim().match(/^(#{1,6})\s*(.*)$/);
      const level = Math.min(6, match?.[1]?.length ?? 1);
      return [pmSchema.nodes.heading.create({ level }, parseInline(match?.[2] ?? ""))];
    }
    case "paragraph":
      return [paragraphFromMarkdown(block.text.trimEnd())];
    case "quote":
      return [blockquoteFromMarkdown(block.text)];
    case "divider":
      return [pmSchema.nodes.horizontal_rule.create()];
    case "code_fence": {
      const fence = extractFence(block);
      return [textBlock(pmSchema.nodes.code_block, fence.body, { params: fence.language })];
    }
    case "html_fence": {
      const fence = extractFence(block);
      return [textBlock(pmSchema.nodes.mh_html, fence.body)];
    }
    case "table":
      return [tableFromMarkdown(block.text)];
    case "media":
      return [mediaFromMarkdown(block.text)];
    case "list":
    case "task":
      return listNodesFromMarkdown(block.text);
    default:
      return [paragraphFromMarkdown(block.text.trimEnd())];
  }
}

function paragraphFromMarkdown(text: string): PMNode {
  const inline = parseInline(text);
  return pmSchema.nodes.paragraph.create(null, inline.length > 0 ? inline : undefined);
}

function emptyParagraph(): PMNode {
  return pmSchema.nodes.paragraph.create();
}

function blockquoteFromMarkdown(text: string): PMNode {
  const stripped = text
    .split("\n")
    .map((line) => line.replace(/^ {0,3}>\s?/, ""))
    .join("\n")
    .trimEnd();
  const nested = parseMarkdownToDoc(stripped);
  const children: PMNode[] = [];
  nested.forEach((child) => children.push(child));
  return pmSchema.nodes.blockquote.create(null, children.length > 0 ? children : [emptyParagraph()]);
}

function textBlock(type: typeof pmSchema.nodes.code_block, text: string, attrs?: Record<string, unknown>): PMNode {
  return type.create(attrs, text.length > 0 ? pmSchema.text(text) : undefined);
}

function mediaFromMarkdown(text: string): PMNode {
  const trimmed = text.trim();
  const imageMatch = trimmed.match(/^!\[([^\]]*)]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
  if (imageMatch) {
    return pmSchema.nodes.image_block.create({
      alt: imageMatch[1] ?? "",
      src: imageMatch[2] ?? "",
      title: imageMatch[3] ?? "",
    });
  }

  const linkMatch = trimmed.match(/^\[([^\]]+)]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
  return pmSchema.nodes.file_link.create({
    label: linkMatch?.[1] ?? "file",
    href: linkMatch?.[2] ?? "#",
    title: linkMatch?.[3] ?? "",
  });
}

function tableFromMarkdown(text: string): PMNode {
  const lines = text.trim().split("\n").filter(Boolean);
  const header = splitTableRow(lines[0] ?? "");
  const rows = lines.slice(2).map(splitTableRow);
  const columnCount = Math.max(header.length, ...rows.map((row) => row.length), 1);

  const makeCell = (cellText: string, headerCell: boolean) => {
    const type = headerCell ? pmSchema.nodes.table_header : pmSchema.nodes.table_cell;
    return type.createAndFill(null, paragraphFromMarkdown(cellText)) ?? type.create(null, paragraphFromMarkdown(cellText));
  };

  const headerRow = pmSchema.nodes.table_row.create(
    null,
    normalizeCells(header, columnCount).map((cell) => makeCell(cell, true)),
  );
  const bodyRows = rows.map((row) =>
    pmSchema.nodes.table_row.create(
      null,
      normalizeCells(row, columnCount).map((cell) => makeCell(cell, false)),
    ),
  );

  return pmSchema.nodes.table.create(null, [headerRow, ...bodyRows]);
}

function listNodesFromMarkdown(text: string): PMNode[] {
  const roots: ListTree[] = [];
  const stack: Array<{ indent: number; list: ListTree; lastItem?: ListItemTree }> = [];

  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      const current = stack.at(-1)?.lastItem;
      if (current) {
        current.text += "\n";
      }
      continue;
    }

    const match = getListLineMatch(line);
    if (!match) {
      const current = stack.at(-1)?.lastItem;
      if (current) {
        current.text += `${current.text ? "\n" : ""}${line.trim()}`;
      }
      continue;
    }

    const indent = (match[1] ?? "").replace(/\t/g, "  ").length;
    const marker = match[2] ?? "-";
    const ordered = /^\d/.test(marker);
    const order = ordered ? Number.parseInt(marker, 10) || 1 : 1;
    const checked = match[3] ? match[3].toLowerCase() === "x" : null;
    const item: ListItemTree = {
      checked,
      text: match[4] ?? "",
      children: [],
    };

    while (stack.length > 0 && indent < (stack.at(-1)?.indent ?? 0)) {
      stack.pop();
    }

    let frame = stack.at(-1);
    if (!frame || indent > frame.indent || frame.list.ordered !== ordered) {
      const list: ListTree = { ordered, order, items: [] };
      if (frame?.lastItem) {
        frame.lastItem.children.push(list);
      } else {
        roots.push(list);
      }
      stack.push({ indent, list });
      frame = stack.at(-1);
    }

    frame?.list.items.push(item);
    if (frame) {
      frame.lastItem = item;
    }
  }

  return roots.map(listTreeToNode);
}

function listTreeToNode(tree: ListTree): PMNode {
  const listType = tree.ordered ? pmSchema.nodes.ordered_list : pmSchema.nodes.bullet_list;
  const items = tree.items.map((item) => {
    const itemType = item.checked === null ? pmSchema.nodes.list_item : pmSchema.nodes.task_item;
    const children = [paragraphFromMarkdown(item.text.trimEnd()), ...item.children.map(listTreeToNode)];
    return itemType.create(item.checked === null ? null : { checked: item.checked }, children);
  });
  return listType.create(tree.ordered ? { order: tree.order } : null, items);
}

function normalizeCells(cells: string[], count: number): string[] {
  return Array.from({ length: count }, (_, index) => cells[index] ?? "");
}

function parseInline(text: string): PMNode[] {
  const token = markdownIt.parseInline(text, {})[0];
  const children = token?.children ?? [];
  const nodes: PMNode[] = [];
  const marks: Mark[] = [];

  for (const child of children) {
    switch (child.type) {
      case "text":
        pushText(nodes, child.content, marks);
        break;
      case "code_inline":
        pushText(nodes, child.content, [pmSchema.marks.code.create()]);
        break;
      case "strong_open":
        marks.push(pmSchema.marks.strong.create());
        break;
      case "strong_close":
        popMark(marks, "strong");
        break;
      case "em_open":
        marks.push(pmSchema.marks.em.create());
        break;
      case "em_close":
        popMark(marks, "em");
        break;
      case "link_open":
        marks.push(
          pmSchema.marks.link.create({
            href: child.attrGet("href") ?? "",
            title: child.attrGet("title"),
          }),
        );
        break;
      case "link_close":
        popMark(marks, "link");
        break;
      case "softbreak":
      case "hardbreak":
        pushText(nodes, "\n", marks);
        break;
      default:
        if (child.content) {
          pushText(nodes, child.content, marks);
        }
    }
  }

  return nodes;
}

function pushText(nodes: PMNode[], text: string, marks: readonly Mark[]): void {
  if (text.length === 0) {
    return;
  }
  nodes.push(pmSchema.text(text, [...marks]));
}

function popMark(marks: Mark[], name: string): void {
  const index = marks.findLastIndex((mark) => mark.type.name === name);
  if (index >= 0) {
    marks.splice(index, 1);
  }
}

export function serializeMarkdown(doc: PMNode): string {
  return serializeChildren(doc, "").trimEnd();
}

function serializeChildren(node: PMNode, indent: string): string {
  const parts: string[] = [];
  node.forEach((child) => {
    parts.push(serializeBlock(child, indent));
  });
  return parts.join("\n\n");
}

function serializeBlock(node: PMNode, indent: string): string {
  switch (node.type.name) {
    case "paragraph":
      return serializeInline(node);
    case "heading":
      return `${"#".repeat(node.attrs.level)} ${serializeInline(node)}`;
    case "blockquote":
      return serializeChildren(node, indent)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "horizontal_rule":
      return "---";
    case "code_block":
      return serializeFence(node.attrs.params || "", node.textContent);
    case "mh_html":
      return serializeFence("mh-html", node.textContent);
    case "bullet_list":
      return serializeList(node, indent, false);
    case "ordered_list":
      return serializeList(node, indent, true);
    case "image_block":
      return imageMarkdown(node);
    case "file_link":
      return linkMarkdown(node.attrs.label, node.attrs.href, node.attrs.title);
    case "table":
      return serializeTable(node);
    default:
      return node.textContent;
  }
}

function serializeList(node: PMNode, indent: string, ordered: boolean): string {
  const lines: string[] = [];
  const start = ordered ? Number(node.attrs.order || 1) : 1;

  node.forEach((item, _offset, index) => {
    const marker = ordered ? `${start + index}.` : "-";
    const task = item.type.name === "task_item" ? ` [${item.attrs.checked ? "x" : " "}]` : "";
    const first = item.firstChild;
    const firstText = first?.type.name === "paragraph" ? serializeInline(first) : "";
    lines.push(`${indent}${marker}${task} ${firstText}`);

    for (let childIndex = 1; childIndex < item.childCount; childIndex += 1) {
      const child = item.child(childIndex);
      const childMarkdown = serializeBlock(child, `${indent}  `);
      lines.push(childMarkdown);
    }
  });

  return lines.join("\n");
}

function serializeInline(node: PMNode): string {
  const parts: string[] = [];
  node.forEach((child) => {
    if (!child.isText) {
      parts.push(child.textContent);
      return;
    }

    let text = child.text ?? "";
    for (const mark of child.marks) {
      if (mark.type.name === "code") {
        text = codeSpan(text);
      } else if (mark.type.name === "link") {
        text = linkMarkdown(text, mark.attrs.href, mark.attrs.title);
      } else if (mark.type.name === "strong") {
        text = `**${text}**`;
      } else if (mark.type.name === "em") {
        text = `*${text}*`;
      }
    }
    parts.push(text);
  });
  return parts.join("");
}

function serializeFence(language: string, body: string): string {
  const maxRun = Math.max(2, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(maxRun + 1);
  return `${fence}${language}\n${body}\n${fence}`;
}

function codeSpan(text: string): string {
  const maxRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(maxRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function imageMarkdown(node: PMNode): string {
  const title = node.attrs.title ? ` "${node.attrs.title}"` : "";
  return `![${node.attrs.alt ?? ""}](${node.attrs.src}${title})`;
}

function linkMarkdown(label: string, href: string, title?: string | null): string {
  const suffix = title ? ` "${title}"` : "";
  return `[${label}](${href}${suffix})`;
}

function serializeTable(node: PMNode): string {
  const rows: string[][] = [];
  node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(escapeTableCell(cell.textContent));
    });
    rows.push(cells);
  });

  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalized = rows.map((row) => normalizeCells(row, columnCount));
  const header = `| ${normalized[0]?.join(" | ")} |`;
  const separator = `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;
  const body = normalized.slice(1).map((row) => `| ${row.join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function getPmRoundTripStatus(doc: PMNode, initial: string, initialSerialized: string): RoundTripStatus {
  const current = serializeMarkdown(doc);
  const reparsed = serializeMarkdown(parseMarkdownToDoc(current));

  if (current === initial) {
    return {
      kind: "exact",
      label: "PM round-trip",
      detail: "Exact match to initial Markdown",
    };
  }

  if (reparsed !== current) {
    return {
      kind: "risk",
      label: "PM round-trip",
      detail: "Content loss risk: serialized Markdown drifts again after reparse",
    };
  }

  return {
    kind: current === initialSerialized ? "normalized" : "normalized",
    label: "PM round-trip",
    detail: current === initialSerialized ? "Normalized once, then stable" : "Stable after current edits",
  };
}

function runPmSelfTest(doc: PMNode): SelfTestResult[] {
  const markdownText = serializeMarkdown(doc);
  const blocks = scanMarkdownBlocks(markdownText);
  const seen = new Set(blocks.map((block) => block.type));
  const sampleRoundTrip = serializeMarkdown(parseMarkdownToDoc(serializeMarkdown(parseMarkdownToDoc(SAMPLE_MARKDOWN))));
  const sampleOnce = serializeMarkdown(parseMarkdownToDoc(SAMPLE_MARKDOWN));

  return [
    ...REQUIRED_BLOCK_TYPES.map((type) => ({
      name: `block:${type}`,
      passed: seen.has(type),
      detail: seen.has(type) ? "serialized Markdown contains block type" : "serialized Markdown is missing block type",
    })),
    {
      name: "round-trip-stable",
      passed: sampleOnce === sampleRoundTrip,
      detail: "sample Markdown normalizes once without ongoing drift",
    },
    {
      name: "mh-html-preserved",
      passed: markdownText.includes("```mh-html") && markdownText.includes("<section data-kind=\"callout\">"),
      detail: "mh-html block serializes as a fenced Markdown block",
    },
    {
      name: "table-pipe-preserved",
      passed: markdownText.includes("a \\| b"),
      detail: "pipe table serializer escaped a literal pipe",
    },
    {
      name: "media-preserved",
      passed: markdownText.includes("![Standalone image]") && markdownText.includes("[Standalone file link]"),
      detail: "image and file link serialize as Markdown links",
    },
    {
      name: "inline-code-mark",
      passed: markdownText.includes("const s") && markdownText.includes("中文") && markdownText.includes("😀"),
      detail: "inline code text and Unicode content survived PM parse/serialize",
    },
  ];
}

const blockDragKey = new PluginKey("pm-block-drag");

function blockDragPlugin(): Plugin {
  return new Plugin({
    key: blockDragKey,
    props: {
      decorations(state) {
        const builder: Array<ReturnType<typeof Decoration.widget>> = [];
        let pos = 0;
        state.doc.forEach((node, offset, index) => {
          const widget = Decoration.widget(offset, blockHandleWidget(index, node.type.name), {
            side: -1,
            key: `block-handle-${index}-${node.type.name}`,
          });
          builder.push(widget);
          pos += node.nodeSize;
        });
        void pos;
        return DecorationSet.create(state.doc, builder);
      },
      handleDOMEvents: {
        dragstart(view, event) {
          const target = event.target as HTMLElement | null;
          const handle = target?.closest<HTMLElement>("[data-pm-block-index]");
          if (!handle || !event.dataTransfer) {
            return false;
          }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/x-metahub-pm-block", handle.dataset.pmBlockIndex ?? "");
          return true;
        },
        dragover(view, event) {
          if (!Array.from(event.dataTransfer?.types ?? []).includes("text/x-metahub-pm-block")) {
            return false;
          }
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }
          return true;
        },
        drop(view, event) {
          const data = event.dataTransfer?.getData("text/x-metahub-pm-block");
          if (!data) {
            return false;
          }
          event.preventDefault();
          const sourceIndex = Number(data);
          if (!Number.isInteger(sourceIndex)) {
            return true;
          }
          const coords = { left: event.clientX, top: event.clientY };
          const targetPos = view.posAtCoords(coords)?.pos ?? view.state.doc.content.size;
          moveTopLevelNode(view, sourceIndex, targetPos);
          return true;
        },
      },
    },
  });
}

function blockHandleWidget(index: number, type: string): () => HTMLElement {
  return () => {
    const handle = document.createElement("span");
    handle.className = "pm-block-handle";
    handle.textContent = "::";
    handle.draggable = true;
    handle.title = `Drag ${type} block`;
    handle.dataset.pmBlockIndex = String(index);
    return handle;
  };
}

function moveTopLevelNode(view: EditorView, sourceIndex: number, targetPos: number): void {
  const source = topLevelByIndex(view.state.doc, sourceIndex);
  const target = topLevelAtPos(view.state.doc, targetPos);
  if (!source || source.index === target?.index) {
    return;
  }

  let insertPos = target ? target.pos : view.state.doc.content.size;
  if (insertPos > source.pos) {
    insertPos -= source.node.nodeSize;
  }
  insertPos = Math.max(0, Math.min(insertPos, view.state.doc.content.size - source.node.nodeSize));

  let tr = view.state.tr
    .delete(source.pos, source.pos + source.node.nodeSize)
    .insert(insertPos, source.node);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(insertPos, tr.doc.content.size)))));
  tr = tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

function topLevelByIndex(doc: PMNode, index: number): TopLevelNode | undefined {
  let found: TopLevelNode | undefined;
  doc.forEach((node, pos, childIndex) => {
    if (childIndex === index) {
      found = { index: childIndex, pos, node };
    }
  });
  return found;
}

function topLevelAtPos(doc: PMNode, targetPos: number): TopLevelNode | undefined {
  let found: TopLevelNode | undefined;
  doc.forEach((node, pos, index) => {
    if (!found && targetPos <= pos + node.nodeSize) {
      found = { index, pos, node };
    }
  });
  return found;
}
