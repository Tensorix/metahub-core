export const SHELL_CSS = `:root{--bg:#fff;--fg:#1f2328;--muted:#6e7781;--line:#d0d7de;--accent:#0969da;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#4493f8;--card:#161b22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
#app{max-width:820px;margin:0 auto;padding:32px 20px 80px}
header.mh{margin-bottom:20px;border-bottom:1px solid var(--line);padding-bottom:14px}header.mh h1{font-size:22px;margin:0}
article.doc h1,article.doc h2,article.doc h3{line-height:1.3;margin:1.4em 0 .5em}article.doc h1{font-size:1.7em}article.doc h2{font-size:1.4em}article.doc h3{font-size:1.2em}
article.doc p{margin:.7em 0}article.doc img{max-width:100%;border-radius:8px}article.doc pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto}
article.doc code{background:var(--card);padding:.15em .35em;border-radius:4px;font-size:.9em}article.doc pre code{background:none;padding:0}
article.doc blockquote{margin:.8em 0;padding:.2em 1em;border-left:3px solid var(--line);color:var(--muted)}
table.db,article.doc table{border-collapse:collapse;width:100%;font-size:14px}table.db td,table.db th,article.doc td,article.doc th{border:1px solid var(--line);padding:7px 10px;text-align:left}
table.db th{background:var(--card)}.table-wrap{overflow:auto}.tag{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px}
.mh-img{text-align:center}.mh-media{text-align:center}.mh-media video,.mh-media audio{max-width:100%}
.mh-file a{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;color:var(--accent);text-decoration:none}
a[data-blob][aria-disabled="true"]{pointer-events:none;color:var(--muted)}
.mh-doclink{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:0 5px;white-space:nowrap}.mh-doclink::before{content:"📄";font-size:.85em;margin-right:3px}
iframe.mh-embed{width:100%;border:1px solid var(--line);border-radius:8px;min-height:240px}
.muted{color:var(--muted)}.err{color:#cf222e}footer.mh{margin-top:48px;border-top:1px solid var(--line);padding-top:14px;color:var(--muted);font-size:12px;text-align:center}
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

export function shellHtml(scriptSrc = "./share-viewer.js"): string {
  return `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>分享</title>
<style>${SHELL_CSS}</style></head><body>
<div id="app">${SKELETON_HTML}</div>
<script type="module" src="${scriptSrc}"></script>
</body></html>`;
}
