import { escapeHtml } from "./html-escape.ts";

export function markdownTable(header: string[], rows: string[][]): string {
  const cell = (s: string) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n");
}

const ICON_COPY = '<svg class="ic-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_CHECK = '<svg class="ic-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17l9-10"/></svg>';

export function copyButtonHtml(): string {
  return `<button id="mh-copy" class="copy-btn" type="button" aria-label="复制全文">${ICON_COPY}${ICON_CHECK}<span>复制全文</span></button>`;
}

export function copySourceHtml(text: string): string {
  return `<template id="mh-src">${escapeHtml(text)}</template>`;
}

export const COPY_CSS = `.mh-tools{display:flex;align-items:center;gap:8px;flex:none}
.copy-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:500 13px/1 inherit;font-family:inherit;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
.copy-btn:hover{background:var(--card)}.copy-btn:active{transform:translateY(.5px)}
.copy-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.copy-btn svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}
.copy-btn .ic-check{display:none}
.copy-btn.done{color:var(--ok,#1a7f37);border-color:var(--ok,#1a7f37)}
.copy-btn.done .ic-copy{display:none}.copy-btn.done .ic-check{display:block}
.copy-btn.done .ic-check path{stroke-dasharray:24;stroke-dashoffset:24;animation:mh-draw .22s ease-out forwards}
.copy-btn.fail{color:#cf222e;border-color:#cf222e}
@keyframes mh-draw{to{stroke-dashoffset:0}}
@media (prefers-color-scheme:dark){:root{--ok:#3fb950}}
@media (max-width:480px){.copy-btn span{display:none}.copy-btn{padding:0 9px}}
@media (prefers-reduced-motion:reduce){.copy-btn .ic-check path{animation:none;stroke-dashoffset:0}}`;

export function copyScript(): string {
  return `(function(){
var btn=document.getElementById('mh-copy');if(!btn)return;
var label=btn.querySelector('span');var timer=0;
function absolutize(root){root.querySelectorAll('img[src],a[href],video[src],audio[src]').forEach(function(el){var a=el.tagName==='A'?'href':'src';var v=el.getAttribute(a);if(v&&!/^(blob|data):/.test(v))el.setAttribute(a,new URL(v,location.href).href);});}
function payload(){var src=document.getElementById('mh-src');var text=src?src.content.textContent:'';var body=document.querySelector('article.doc')||document.querySelector('.table-wrap');var html='';if(body){var c=body.cloneNode(true);absolutize(c);html=c.innerHTML;}return{text:text,html:html};}
function legacy(text){var ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.cssText='position:fixed;top:0;left:0;opacity:0';document.body.appendChild(ta);ta.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}ta.remove();return ok?Promise.resolve():Promise.reject(new Error('copy'));}
function write(p){var nc=navigator.clipboard;if(nc&&nc.write&&window.ClipboardItem){try{return nc.write([new ClipboardItem({'text/plain':new Blob([p.text],{type:'text/plain'}),'text/html':new Blob([p.html],{type:'text/html'})})]);}catch(e){}}if(nc&&nc.writeText)return nc.writeText(p.text);return legacy(p.text);}
function settle(cls,txt){clearTimeout(timer);btn.classList.remove('done','fail');void btn.offsetWidth;btn.classList.add(cls);if(label)label.textContent=txt;timer=setTimeout(function(){btn.classList.remove(cls);if(label)label.textContent='复制全文';},1600);}
btn.addEventListener('click',function(){var p=payload();write(p).then(function(){settle('done','已复制');},function(){legacy(p.text).then(function(){settle('done','已复制');},function(){settle('fail','复制失败');});});});
})();`;
}
