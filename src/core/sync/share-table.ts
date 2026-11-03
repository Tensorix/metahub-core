// Shared presentation for live server shares and decrypted snapshot shares.
// Full values stay in the DOM; the drawer reads only the already-shared cells.
import { mountShareTable } from "./share-table-client.js";
import { escapeHtml } from "./html-escape.ts";
import { pm } from "./page-messages.ts";
import type { Locale } from "./locale.ts";

const expandIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>';
const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

/** html and editAttrs must be produced by the caller's escaped cell renderer. */
export function shareCellHtml(html: string, name: string, locale: Locale, editAttrs = ""): string {
  return `<td><div class="share-cell-value"${editAttrs ? ` ${editAttrs}` : ""}>${html}</div><button type="button" class="share-cell-expand" hidden aria-label="${escapeHtml(pm(locale, "查看「{name}」全文", { name }))}" title="${escapeHtml(pm(locale, "查看全文"))}">${expandIcon}</button></td>`;
}

export function shareTableHtml(columns: { name: string; width?: number }[], rows: string, locale: Locale): string {
  const widths = columns.map((p) => typeof p.width === "number" && Number.isFinite(p.width) ? Math.max(80, Math.min(640, p.width)) : 180);
  return `<div class="table-wrap"><table class="db share-table" style="width:${widths.reduce((a, b) => a + b, 0)}px"><colgroup>${widths.map((w) => `<col style="width:${w}px">`).join("")}</colgroup><thead><tr>${columns.map((p) => `<th scope="col" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
<dialog class="share-text-peek" aria-labelledby="share-text-heading">
  <div class="share-text-toolbar"><button type="button" class="share-text-close" aria-label="${escapeHtml(pm(locale, "关闭"))}" autofocus>${closeIcon}</button><button type="button" class="copy-btn share-text-copy">${escapeHtml(pm(locale, "复制全文"))}</button><span class="share-text-feedback" role="status"></span></div>
  <div class="share-text-heading"><h2 id="share-text-heading"></h2><p class="share-text-record"></p></div>
  <div class="share-text-body" tabindex="0"></div>
</dialog>`;
}

export const SHARE_TABLE_CSS = `
#app:has(.share-table),.wrap:has(.share-table){max-width:1440px}
.table-wrap:has(.share-table){max-width:100%;overflow:auto;overscroll-behavior-x:contain}
table.share-table{table-layout:fixed;min-width:100%}
table.share-table th{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--muted)}
table.share-table td{position:relative;vertical-align:top}
.share-cell-value{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
.share-table[data-ready] .share-cell-value{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;max-height:4.65em}
.share-table .tag{max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;white-space:nowrap}
.share-cell-expand{position:absolute;top:5px;right:5px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--fg);cursor:pointer;opacity:0;pointer-events:none}
.share-cell-expand[hidden]{display:none}
.share-cell-expand svg,.share-text-close svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.share-table td:is(:hover,:focus-within,.is-selected) .share-cell-expand{opacity:1;pointer-events:auto}
.share-table td.is-selected{box-shadow:inset 0 0 0 1.5px var(--accent);background:var(--accent-soft)}
.share-cell-expand:hover,.share-text-close:hover{background:var(--card)}
.share-cell-expand:focus-visible,.share-text-close:focus-visible,.share-text-body:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.share-table[data-ready] [contenteditable]:focus{display:block;-webkit-line-clamp:unset;max-height:min(320px,40vh);overflow:auto;outline:2px solid var(--accent);outline-offset:2px}
.share-cell-value.saving{opacity:.5}.share-cell-value.saved{background:color-mix(in srgb,var(--success) 18%,transparent)}
.share-text-peek{position:fixed;inset:0 0 0 auto;margin:0;padding:0;width:min(620px,100vw);max-width:100vw;height:100vh;height:100dvh;max-height:100dvh;border:0;border-inline-start:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;overflow:hidden}
.share-text-peek[open]{display:flex;flex-direction:column}
.share-text-peek::backdrop{background:rgba(15,15,25,.3)}
body:has(.share-text-peek[open]){overflow:hidden}
.share-text-toolbar{display:flex;align-items:center;gap:12px;flex:none;padding:12px 20px;border-bottom:1px solid var(--line)}
.share-text-close{display:flex;align-items:center;justify-content:center;width:32px;height:32px;margin-inline-end:auto;border:0;border-radius:5px;background:transparent;color:var(--muted);cursor:pointer}
.share-text-feedback{font-size:13px;color:var(--muted)}.share-text-feedback:empty{display:none}
.share-text-heading{flex:none;padding:24px 32px 16px;min-width:0}
.share-text-heading h2{margin:0;font-size:20px;line-height:1.4;overflow-wrap:anywhere}
.share-text-record{margin:6px 0 0;font-size:13px;color:var(--muted);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.share-text-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 32px 40px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75;user-select:text}
@media(max-width:600px){.share-text-peek{width:100vw}.share-text-toolbar{padding:10px 14px}.share-text-heading{padding:20px 20px 16px}.share-text-body{padding:0 20px 32px;font-size:16px}}
@media(hover:none),(pointer:coarse){.share-cell-expand{opacity:1;pointer-events:auto;width:44px;height:44px;top:0;right:0}.share-table td:has(.share-cell-expand:not([hidden])) .share-cell-value{min-height:44px}.share-text-close{width:44px;height:44px}}
`;

export { mountShareTable } from "./share-table-client.js";

export function shareTableScript(locale: Locale): string {
  return `(${mountShareTable.toString()})(${JSON.stringify({ copied: pm(locale, "已复制"), failed: pm(locale, "复制失败"), record: pm(locale, "记录") })});`;
}
