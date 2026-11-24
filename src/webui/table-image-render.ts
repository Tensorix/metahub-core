// Let the browser lay out the cells, including mixed scripts, wrapped labels and
// inline Markdown. Paint that layout directly to canvas so the offline WebViews
// can produce PNGs without frames, external resources or SVG foreignObject.
import { LIGHT_THEME as paper } from "../core/ui-theme.ts";
import { optColor } from "./option-color.ts";
import { t } from "./i18n/t.ts";

export type TableImageCell = string | HTMLElement | { chips: string[] } | { checked: boolean };
export interface TableImageData {
  rows: TableImageCell[][];
  headerRow: boolean;
  widths?: number[];
  align?: ("left" | "center" | "right" | null)[];
}

const MAX_EDGE = 16_384;
const MAX_PIXELS = 16_000_000;
const MIN_WIDTH = 48;
const MIN_HEIGHT = 34;

function assertDimensions(width: number, height: number) {
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS)
    throw new Error(t("表格过大，请缩小范围后重试"));
}

export function assertTableImageSize(rowCount: number, columnCount: number) {
  if (rowCount < 1 || columnCount < 1) throw new Error(t("无法生成表格图片，请重试"));
  assertDimensions(columnCount * MIN_WIDTH, rowCount * MIN_HEIGHT);
}

const exportStyles = `
  table { border-spacing:0; table-layout:fixed; font:14px/20px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; color:${paper.fg}; }
  td,th { box-sizing:border-box; height:${MIN_HEIGHT}px; padding:7px 10px; vertical-align:top; text-align:left; font-weight:400;
    white-space:pre-wrap; overflow-wrap:anywhere; border:solid transparent; border-width:0 1px 1px 0; }
  th { font-weight:650; }
  code { font:13px/20px ui-monospace,monospace; background:${paper["code-bg"]}; padding:1px 3px; }
  .link { color:${paper.accent}; text-decoration:underline; }
  .chip { display:inline-block; vertical-align:top; max-width:100%; box-sizing:border-box; margin:1px 4px 1px 0; padding:0 6px;
    font-size:13px; line-height:20px; font-weight:500; }
  .check { display:inline-block; width:15px; height:15px; vertical-align:-2px; }
  .media { display:inline-block; vertical-align:middle; max-width:100%; }
`;

type Images = Map<HTMLElement, HTMLImageElement>;

function appendInline(parent: HTMLElement, node: Node, images: Images) {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.append(node.textContent ?? "");
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  const tag = node.localName;
  if (tag === "br") { parent.append(document.createElement("br")); return; }
  if (node instanceof HTMLImageElement) {
    const box = document.createElement("span");
    box.textContent = node.alt || t("图片");
    images.set(box, node);
    parent.append(box);
    return;
  }
  const inline = ["b", "strong", "em", "i", "code", "s", "del", "strike", "u"].includes(tag) ? tag : "span";
  const span = document.createElement(inline);
  if (tag === "a") span.className = "link";
  if (tag === "div" && parent.lastChild) parent.append(document.createElement("br"));
  for (const child of node.childNodes) appendInline(span, child, images);
  parent.append(span);
}

// Lazy images below the fold may not have decoded yet. Read them without
// changing the editor's loading state. External images need a CORS-clean
// response; leave their accessible label when the origin or network refuses.
async function prepareImages(images: Images) {
  await Promise.all(Array.from(images, async ([box, original]) => {
    const src = original.currentSrc || original.getAttribute("src");
    if (!src) return;
    const url = new URL(src, document.baseURI);
    const local = url.origin === location.origin || url.protocol === "data:";
    let img = original;
    if (!img.complete || !img.naturalWidth || (!local && !img.crossOrigin)) {
      img = new Image();
      if (!local) img.crossOrigin = "anonymous";
      const ready = await new Promise<boolean>(resolve => {
        const finish = (success: boolean) => {
          clearTimeout(timer);
          img.onload = img.onerror = null;
          if (!success) img.removeAttribute("src");
          resolve(success);
        };
        const timer = setTimeout(() => finish(false), 3000);
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        img.src = url.href;
      });
      if (!ready) return;
    }
    box.textContent = "";
    box.className = "media";
    box.style.width = Math.min(original.width || img.naturalWidth, img.naturalWidth) + "px";
    box.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    images.set(box, img);
  }));
}

function fillCell(td: HTMLTableCellElement, cell: TableImageCell, images: Images) {
  if (typeof cell === "string") td.textContent = cell;
  else if (cell instanceof HTMLElement) {
    for (const child of cell.childNodes) appendInline(td, child, images);
  } else if ("checked" in cell) {
    const check = document.createElement("span");
    check.className = "check";
    check.dataset.checked = String(cell.checked);
    td.append(check);
  } else {
    for (const text of cell.chips) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.style.backgroundColor = optColor(text);
      chip.textContent = text;
      td.append(chip);
    }
  }
}

// A text node can occupy several line boxes (and several bidi runs). Find the
// longest prefix in one box, then draw that substring at its browser position.
function paintText(ctx: CanvasRenderingContext2D, node: Text, range: Range) {
  const text = node.data;
  if (!text) return;
  const style = getComputedStyle(node.parentElement!);
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  ctx.fillStyle = style.color;
  const decoration = node.parentElement!.closest(".link,u,s,del,strike");
  for (let start = 0; start < text.length;) {
    range.setStart(node, start);
    range.setEnd(node, text.length);
    let end = text.length;
    if (range.getClientRects().length > 1) {
      let low = start + 1, high = end;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        range.setEnd(node, mid);
        if (range.getClientRects().length <= 1) low = mid;
        else high = mid - 1;
      }
      end = low;
      range.setEnd(node, end);
    }
    const rect = range.getBoundingClientRect();
    if (rect.width && rect.height) {
      const y = rect.top + rect.height / 2;
      ctx.fillText(text.slice(start, end).replace(/[\r\n]/g, ""), rect.left, y);
      if (decoration) ctx.fillRect(rect.left, y + (decoration.matches("s,del,strike") ? 0 : 7), rect.width, 1);
    }
    start = end;
  }
}

function paintCell(ctx: CanvasRenderingContext2D, cell: HTMLTableCellElement, images: Images, range: Range) {
  const box = cell.getBoundingClientRect();
  ctx.fillStyle = cell.tagName === "TH" ? paper.surface : paper.paper;
  // The exposed pixel between adjacent fills is the grid rule.
  ctx.fillRect(box.x + 1, box.y + 1, box.width - 1, box.height - 1);
  for (const el of cell.querySelectorAll<HTMLElement>("code,.chip,.check,.media")) {
    for (const rect of el.getClientRects()) {
      const { x, y, width, height } = rect;
      const img = images.get(el);
      if (img) { ctx.drawImage(img, x, y, width, height); continue; }
      const checked = el.dataset.checked;
      ctx.fillStyle = checked === undefined ? getComputedStyle(el).backgroundColor :
        checked === "true" ? paper.accent : paper.muted;
      ctx.globalAlpha = el.className === "chip" ? 0.16 : 1;
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (checked === "false") {
        ctx.fillStyle = paper.paper;
        ctx.fillRect(x + 1.5, y + 1.5, width - 3, height - 3);
      } else if (checked === "true") {
        ctx.strokeStyle = paper.paper;
        ctx.lineWidth = 1.7;
        ctx.beginPath();
        ctx.moveTo(x + 3, y + 7); ctx.lineTo(x + 6, y + 10); ctx.lineTo(x + 12, y + 4);
        ctx.stroke();
      }
    }
  }
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) paintText(ctx, walker.currentNode as Text, range);
}

export async function renderTableImage(data: TableImageData): Promise<Blob> {
  const columns = data.rows[0]?.length ?? 0;
  assertTableImageSize(data.rows.length, columns);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:0;left:0;width:max-content;visibility:hidden;pointer-events:none;contain:layout style paint";
  host.inert = true;
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = exportStyles;
  const table = document.createElement("table");
  const colgroup = document.createElement("colgroup");
  let width = 0;
  for (let c = 0; c < columns; c++) {
    const col = document.createElement("col");
    const columnWidth = Math.max(MIN_WIDTH, Math.round(data.widths?.[c] || 160));
    col.style.width = columnWidth + "px";
    width += columnWidth;
    colgroup.append(col);
  }
  assertDimensions(width + 1, data.rows.length * MIN_HEIGHT + 1);
  table.style.width = width + "px";
  table.append(colgroup);
  const images: Images = new Map();
  for (const [r, row] of data.rows.entries()) {
    const tr = table.insertRow();
    for (let c = 0; c < columns; c++) {
      const td = document.createElement(data.headerRow && !r ? "th" : "td");
      td.style.textAlign = data.align?.[c] ?? "left";
      fillCell(td, row[c] ?? "", images);
      tr.append(td);
    }
  }
  if (images.size) await prepareImages(images);
  shadow.append(style, table);
  document.body.append(host);
  const canvas = document.createElement("canvas");
  try {
    const box = table.getBoundingClientRect();
    const width = Math.ceil(box.width) + 1, height = Math.ceil(box.height) + 1;
    assertDimensions(width, height);
    const scale = Math.min(2, MAX_EDGE / width, MAX_EDGE / height, Math.sqrt(MAX_PIXELS / (width * height)));
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(t("无法生成表格图片，请重试"));
    ctx.scale(canvas.width / width, canvas.height / height);
    ctx.fillStyle = paper["line-strong"];
    ctx.fillRect(0, 0, width, height);
    ctx.translate(-box.x, -box.y);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const range = document.createRange();
    for (const tr of table.rows) for (const cell of tr.cells) paintCell(ctx, cell, images, range);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error(t("无法生成表格图片，请重试"))), "image/png",
    ));
  } finally {
    host.remove();
    canvas.width = canvas.height = 0;
  }
}
