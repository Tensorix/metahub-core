import { escapeHtml } from "./html-escape.ts";
import { copyButtonHtml } from "./share-copy.ts";
import { pm } from "./page-messages.ts";
import type { Locale } from "./locale.ts";

export type ShareContentKind = "doc" | "database";

/** RFC 4180: keep newlines, quotes, empty cells and significant whitespace. */
export function csvTable(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
}

export function shareToolsHtml(kind: ShareContentKind, title: string, locale: Locale, extra = ""): string {
  const ext = kind === "doc" ? "md" : "csv";
  const name = title.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").trim().slice(0, 160).replace(/[. ]+$/, "") || "download";
  const wide = escapeHtml(pm(locale, "宽屏"));
  const download = escapeHtml(pm(locale, "下载"));
  return `<div class="mh-tools share-tools">
<button id="mh-width" class="copy-btn share-width" type="button" aria-pressed="false" aria-label="${wide}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m9 10-2 2 2 2m6-4 2 2-2 2"/></svg><span>${wide}</span></button>
<span class="share-tool-divider" aria-hidden="true"></span>${copyButtonHtml(locale)}
<button id="mh-download" class="copy-btn share-download" type="button" data-filename="${escapeHtml(name + "." + ext)}" aria-label="${download}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg><span>${download}</span></button>${extra}
</div><span class="share-tool-feedback" role="status"></span>`;
}

/** Used by both live server pages and decrypted snapshot pages. No network calls:
 *  exports only the Markdown / complete cell values already shared on this page. */
export function shareToolsScript(locale: Locale): string {
  const labels = JSON.stringify({ wide: pm(locale, "宽屏"), narrow: pm(locale, "收窄"), download: pm(locale, "已开始下载"), failed: pm(locale, "下载失败"), saving: pm(locale, "请等待保存完成") });
  return `(function(){
var btn=document.getElementById('mh-download'),widthBtn=document.getElementById('mh-width');if(!btn||!widthBtn)return;
var root=document.querySelector('[data-share-kind]'),L=${labels};if(!root)return;
var key='mh-share-width-'+root.dataset.shareKind,feedback=document.querySelector('.share-tool-feedback'),timer;
function setWide(wide){root.dataset.shareWide=String(wide);widthBtn.setAttribute('aria-pressed',String(wide));widthBtn.setAttribute('aria-label',wide?L.narrow:L.wide);widthBtn.querySelector('span').textContent=wide?L.narrow:L.wide;}
try{setWide(localStorage.getItem(key)==='wide');}catch(e){setWide(false);}
widthBtn.addEventListener('click',function(){var wide=root.dataset.shareWide!=='true';setWide(wide);try{localStorage.setItem(key,wide?'wide':'standard');}catch(e){}});
function report(text){if(!feedback)return;clearTimeout(timer);feedback.textContent=text;timer=setTimeout(function(){feedback.textContent='';},2400);}
var csv=${csvTable.toString()};
function cellText(cell){var value=cell.querySelector('.share-cell-value')||cell,tags=value.querySelectorAll('.tag');return tags.length?Array.from(tags).map(function(tag){return tag.textContent||'';}).join(', '):value.textContent||'';}
btn.addEventListener('click',function(){
if(root.querySelector('.saving')||root.querySelector('.mh-raw')){report(L.saving);return;}
var url,a;try{
var table=root.querySelector('table.share-table'),text;
if(table){var header=Array.from(table.querySelectorAll('thead th')).map(function(th){return th.textContent||'';});var rows=Array.from(table.querySelectorAll('tbody tr')).map(function(tr){return Array.from(tr.querySelectorAll('td')).map(cellText);});text='\\uFEFF'+csv(header,rows);}
else{var src=document.getElementById('mh-src');if(!src)throw new Error('source');text=src.content.textContent||'';}
url=URL.createObjectURL(new Blob([text],{type:table?'text/csv;charset=utf-8':'text/markdown;charset=utf-8'}));a=document.createElement('a');a.href=url;a.download=btn.dataset.filename;a.hidden=true;document.body.appendChild(a);a.click();report(L.download);
}catch(e){report(L.failed);}finally{if(a)a.remove();if(url)setTimeout(function(){URL.revokeObjectURL(url);},60000);}
});
})();`;
}

export const SHARE_TOOLS_CSS = `
.share-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;position:relative;margin-bottom:28px}
.share-brand{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:650;letter-spacing:-.03em;flex:none}
.share-tools{flex-wrap:wrap;justify-content:flex-end;gap:8px}
.share-tools .copy-btn{height:40px;white-space:nowrap;font-size:13px;line-height:1}
.share-tools .share-download{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.share-tools .share-download:hover{background:var(--accent);border-color:var(--accent);filter:brightness(1.08)}
.share-tools .share-width{background:transparent;border-color:transparent;color:var(--muted)}
.share-tools .share-width:hover{background:var(--card);color:var(--fg)}
.share-tools .share-width[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft)}
.share-tool-divider{height:18px;width:1px;background:var(--line);margin-inline:4px;flex:none}
.share-tool-feedback{position:absolute;right:0;top:calc(100% + 4px);display:block;text-align:right;font-size:12px;line-height:1.25;color:var(--muted)}
.share-tool-feedback:empty{display:none}
#app[data-share-kind="doc"][data-share-wide="true"],.wrap[data-share-kind="doc"][data-share-wide="true"]{max-width:1200px}
#app[data-share-kind="database"][data-share-wide="true"],.wrap[data-share-kind="database"][data-share-wide="true"]{max-width:none;padding-inline:24px}
@media(max-width:600px){.share-topbar{gap:10px;margin-bottom:20px;flex-wrap:wrap}.share-tools{gap:6px}.share-tools .share-width,.share-tool-divider{display:none}.share-tools .copy-btn{height:44px;padding-inline:10px}.share-tools .share-download span{display:inline}.share-tools #mh-copy span{display:inline;font-size:0}.share-tools #mh-copy span::after{content:attr(data-compact);font-size:13px}#app[data-share-kind][data-share-wide="true"],.wrap[data-share-kind][data-share-wide="true"]{padding-inline:16px}}
`;
