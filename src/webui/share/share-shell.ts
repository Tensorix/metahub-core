import { COPY_CSS } from "../../core/sync/share-copy.ts";
import { SHARE_FILE_CSS } from "../../core/sync/share-file-styles.ts";
import { pm } from "../../core/sync/page-messages.ts";

export const SHELL_CSS = `:root{--bg:#fbfbfa;--fg:#2c2c30;--muted:#6b6b75;--line:#e4e4e7;--accent:#4a55d6;--card:#f1f1ef;--paper:#fff;--accent-soft:#eef0ff;--accent-fg:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a1c;--fg:#e6e6e9;--muted:#a0a0aa;--line:#3a3a40;--accent:#7b86ff;--card:#2a2a2d;--paper:#202022;--accent-soft:#23243a;--accent-fg:#14141a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
#app{max-width:820px;margin:0 auto;padding:32px 20px 80px}
header.mh{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:20px;border-bottom:1px solid var(--line);padding-bottom:14px}header.mh h1{font-size:22px;margin:0;overflow-wrap:anywhere}
${COPY_CSS}
article.doc h1,article.doc h2,article.doc h3{line-height:1.3;margin:1.4em 0 .5em}article.doc h1{font-size:1.7em}article.doc h2{font-size:1.4em}article.doc h3{font-size:1.2em}
article.doc p{margin:.7em 0}article.doc img{max-width:100%;border-radius:8px}article.doc pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto}
article.doc code{background:var(--card);padding:.15em .35em;border-radius:4px;font-size:.9em}article.doc pre code{background:none;padding:0}
article.doc blockquote{margin:.8em 0;padding:.2em 1em;border-left:3px solid var(--line);color:var(--muted)}
table.db,article.doc table{border-collapse:collapse;width:100%;font-size:14px}table.db td,table.db th,article.doc td,article.doc th{border:1px solid var(--line);padding:7px 10px;text-align:left}
table.db th{background:var(--card)}.table-wrap{overflow:auto}.tag{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px}
.mh-img{text-align:center}.mh-media{text-align:center}.mh-media video,.mh-media audio{max-width:100%}
${SHARE_FILE_CSS}
a[data-blob][aria-disabled="true"]{pointer-events:none;color:var(--muted)}
.mh-doclink{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:0 5px;white-space:nowrap}.mh-doclink::before{content:"📄";font-size:.85em;margin-right:3px}
iframe.mh-embed{width:100%;border:1px solid var(--line);border-radius:8px;min-height:240px}
.muted{color:var(--muted)}.err{color:#cf222e}footer.mh{margin-top:48px;border-top:1px solid var(--line);padding-top:14px;color:var(--muted);font-size:12px;text-align:center}
body:has(.share-error){--card:var(--paper)}
.share-error{min-height:calc(100svh - 112px);display:flex;flex-direction:column;gap:40px}
::selection{background:var(--accent-soft);color:var(--accent)}
.share-error-brand,.share-brand{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:650;letter-spacing:-.03em}
.share-brand-mark{display:block;position:relative;width:28px;height:28px;flex:none}
.share-brand-mark img{position:absolute;width:143.284%;height:143.284%;max-width:none;left:-21.642%;top:-22.761%}
.share-error-main{position:relative;overflow:hidden;width:100%;max-width:520px;margin:auto;padding:48px 36px 40px;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:16px}
.share-error-main::after,.share-content::after{content:"";position:absolute;height:3px;bottom:0;left:0;right:0;background:linear-gradient(to right,#335cff 0% 25%,#8967ed 25% 50%,#18b7b6 50% 75%,#f28b55 75% 100%)}
.share-error-emblem{position:relative;width:80px;height:80px;margin:0 auto 32px}
.share-error-emblem .share-brand-mark{width:80px;height:80px}
.share-error-icon{position:absolute;right:-10px;bottom:-8px;width:32px;height:32px;padding:6px;border-radius:10px;background:var(--accent-soft);color:var(--accent);box-shadow:0 0 0 4px var(--card)}
.share-error h1{font-size:clamp(24px,4vw,30px);line-height:1.35;letter-spacing:-.025em;margin:0 0 12px;text-wrap:balance}
.share-error-reason{margin:0 0 28px;color:var(--muted);font-size:15px;overflow-wrap:anywhere}
.share-error-help{border-top:1px solid var(--line);padding-top:24px;font-size:14px;line-height:1.8;text-wrap:pretty}
.share-error-help p{margin:0}.share-error-help p+p{margin-top:8px;color:var(--muted)}
.share-error-retry{margin-top:24px;min-height:44px;padding:10px 22px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.share-error-retry:hover{filter:brightness(1.1)}.share-error-retry:active{filter:brightness(.95)}.share-error-retry:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.share-error footer.mh{margin-top:0;border:0;padding-top:0}
@media(max-width:480px){.share-error{gap:32px}.share-error-main{padding:40px 20px 32px}.share-error-help{padding-top:20px}}
.share-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}
.share-topbar .copy-btn{height:40px;background:var(--paper)}.share-topbar .copy-btn:hover{background:var(--accent-soft);border-color:var(--accent)}
.share-content{position:relative;overflow:hidden;background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:36px 40px 44px}
.share-content header.mh{margin-bottom:28px;padding-bottom:24px}.share-content header.mh h1{font-size:clamp(24px,4vw,32px);line-height:1.35;letter-spacing:-.025em}
.share-content article.doc{overflow-wrap:anywhere;line-height:1.8}.share-content article.doc>:first-child{margin-top:0}.share-content article.doc>:last-child{margin-bottom:0}
.share-content a{color:var(--accent);text-underline-offset:3px}.share-content a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.share-content article.doc pre{line-height:1.6;overflow-wrap:normal}.share-content article.doc blockquote{border-left:2px solid var(--accent);color:var(--muted)}
.share-content article.doc table{display:block;max-width:100%;overflow:auto}.share-content table.db td,.share-content table.db th{padding:11px 14px;min-width:100px}
.share-content table.db tbody tr:hover{background:var(--bg)}.share-content .tag{background:var(--accent-soft);color:var(--accent);border:0;border-radius:6px}
.mh-view>footer.mh{border:0;margin-top:28px;padding-top:0}
@media(max-width:600px){#app{padding:24px 16px 48px}.share-topbar{margin-bottom:20px}.share-content{padding:24px 20px 32px}.share-content header.mh{margin-bottom:24px;padding-bottom:20px}.share-topbar .copy-btn{min-width:44px;height:44px;justify-content:center}}
.skel{animation:skel-in .25s ease .12s both}
.skel-b{display:block;position:relative;overflow:hidden;background:var(--card);border-radius:6px;width:var(--w,100%)}
.skel-b::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent 20%,color-mix(in srgb,var(--fg) 5%,transparent) 50%,transparent 80%);background-size:200% 100%;animation:skel-sweep 1.6s ease-in-out infinite;animation-delay:calc(var(--i,0) * 120ms)}
.skel-h{height:28px}.skel-l{height:1em;margin:.34em 0}.skel-h2{height:1.4em;margin:1.4em 0 .5em}.skel-card{height:132px;border-radius:8px;margin:.9em 0}
.skel-media{aspect-ratio:16/9;max-width:520px;margin:.9em auto;border-radius:8px}
.skel-media.dead{aspect-ratio:auto;padding:12px;text-align:center;color:var(--muted);font-size:13px;border:1px dashed var(--line);background:none}.skel-media.dead::after{animation:none;background:none}
#app>.mh-view{animation:skel-in .18s ease both}
@keyframes skel-in{from{opacity:0}to{opacity:1}}
@keyframes skel-sweep{from{background-position:100% 0}to{background-position:-100% 0}}
@media (prefers-reduced-motion:reduce){.skel-b::after{animation:none}.skel,#app>.mh-view{animation:none}}`;

const line = (i: number, w: number) => `<span class="skel-b skel-l" style="--i:${i};--w:${w}%"></span>`;

export const SKELETON_HTML = `<div class="skel" role="status" aria-busy="true" aria-label="正在加载">
<header class="mh"><span class="skel-b skel-h" style="--i:0;--w:38%"></span></header>
<article class="doc">
<p>${line(1, 96)}${line(2, 89)}${line(3, 72)}</p>
<span class="skel-b skel-h2" style="--i:4;--w:34%"></span>
<p>${line(5, 92)}${line(6, 84)}${line(7, 58)}</p>
<span class="skel-b skel-card" style="--i:8"></span>
<p>${line(9, 95)}${line(10, 46)}</p>
</article>
</div>`;

const LANG_SCRIPT = `try{var ls=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language],en=true;for(var i=0;i<ls.length;i++){var g=ls[i]||'';if(/^zh/i.test(g)){en=false;break}if(/^en/i.test(g))break}if(en){document.documentElement.lang='en';document.title=${JSON.stringify(pm("en", "分享"))};var s=document.querySelector('.skel');if(s)s.setAttribute('aria-label',${JSON.stringify(pm("en", "正在加载"))})}}catch(e){}`;

export function shellHtml(scriptSrc = "./share-viewer.js"): string {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${pm("zh-CN", "分享")}</title>
<link rel="icon" type="image/png" href="./favicon.png">
<style>${SHELL_CSS}</style></head><body>
<div id="app">${SKELETON_HTML}</div>
<script>${LANG_SCRIPT}</script>
<script type="module" src="${scriptSrc}"></script>
</body></html>`;
}
