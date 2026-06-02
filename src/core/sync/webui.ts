import { fileURLToPath } from "node:url";

// Serves the browser WebUI at `/`. This module is imported lazily from
// server.ts (only when a browser actually hits `/` or `/webui.js`), so neither
// it nor the Preact bundle ever enters the CLI's startup import graph — zero
// cost to `mh <command>`.

/** The HTML shell. The Preact app is delivered separately as /webui.js. CSS is
 *  inlined here to avoid a third asset route and keep it out of the JS bundle. */
const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Metahub</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script>try{document.documentElement.dataset.theme=localStorage.getItem('mh-theme')||'system'}catch(e){}</script>
<style>
  :root {
    --bg:#ffffff; --surface:#fbfbfa; --surface-2:#f1f1ef; --sidebar:#f7f7f5;
    --fg:#2c2c30; --fg-soft:#5b5b62; --muted:#8a8a93; --line:#ebebe8; --line-strong:#dededb;
    --accent:#4a55d6; --accent-fg:#ffffff; --accent-soft:#eef0ff; --danger:#d6473b; --danger-soft:#fdeceb;
    --hover:rgba(45,45,55,.045); --hover-2:rgba(45,45,55,.08);
    --shadow-sm:0 1px 2px rgba(20,20,40,.06),0 1px 1px rgba(20,20,40,.04);
    --shadow-md:0 4px 12px rgba(20,20,40,.08),0 2px 4px rgba(20,20,40,.05);
    --shadow-lg:0 16px 48px rgba(20,20,40,.16),0 4px 12px rgba(20,20,40,.08);
    --radius:8px; --radius-sm:6px;
    --ui:"Hanken Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;
    --code-bg:#f8f8f6;
    --hl-cmt:#9a9aa2; --hl-key:#a626a4; --hl-str:#28823f; --hl-num:#b76a00;
    --hl-fn:#3f51d6; --hl-type:#0a7ea4; --hl-var:#c2410c;
  }
  /* Dark palette. Applied (a) when explicitly chosen via [data-theme="dark"],
   * or (b) when following the system and the OS reports dark. Light is the
   * default :root above, so [data-theme="light"] needs no extra rule. */
  :root[data-theme="dark"] {
    --bg:#1a1a1c; --surface:#202022; --surface-2:#2a2a2d; --sidebar:#171719;
    --fg:#e6e6e9; --fg-soft:#b4b4bb; --muted:#7d7d86; --line:#2c2c30; --line-strong:#3a3a40;
    --accent:#7b86ff; --accent-fg:#14141a; --accent-soft:#23243a; --danger:#f87168; --danger-soft:#341e1c;
    --hover:rgba(255,255,255,.05); --hover-2:rgba(255,255,255,.09);
    --shadow-sm:0 1px 2px rgba(0,0,0,.4); --shadow-md:0 4px 14px rgba(0,0,0,.45); --shadow-lg:0 20px 56px rgba(0,0,0,.6);
    --code-bg:#1d1d20;
    --hl-cmt:#7d7d86; --hl-key:#d291e4; --hl-str:#7ed492; --hl-num:#e0a566;
    --hl-fn:#86a8ff; --hl-type:#5fc6e0; --hl-var:#f0936b;
  }
  @media (prefers-color-scheme: dark) {
    :root[data-theme="system"], :root:not([data-theme]) {
      --bg:#1a1a1c; --surface:#202022; --surface-2:#2a2a2d; --sidebar:#171719;
      --fg:#e6e6e9; --fg-soft:#b4b4bb; --muted:#7d7d86; --line:#2c2c30; --line-strong:#3a3a40;
      --accent:#7b86ff; --accent-fg:#14141a; --accent-soft:#23243a; --danger:#f87168; --danger-soft:#341e1c;
      --hover:rgba(255,255,255,.05); --hover-2:rgba(255,255,255,.09);
      --shadow-sm:0 1px 2px rgba(0,0,0,.4); --shadow-md:0 4px 14px rgba(0,0,0,.45); --shadow-lg:0 20px 56px rgba(0,0,0,.6);
      --code-bg:#1d1d20;
      --hl-cmt:#7d7d86; --hl-key:#d291e4; --hl-str:#7ed492; --hl-num:#e0a566;
      --hl-fn:#86a8ff; --hl-type:#5fc6e0; --hl-var:#f0936b;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { font-family: var(--ui); font-size: 14px; line-height: 1.55; color: var(--fg); background: var(--bg);
    overflow: hidden; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  button { font: inherit; color: inherit; cursor: pointer; background: none; border: 0; padding: 0; }
  input, textarea { font: inherit; color: inherit; }
  .muted { color: var(--muted); }
  svg { display: block; }
  .ico { width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.75; stroke-linecap:round; stroke-linejoin:round; flex:none; }
  .ico.sm { width:14px; height:14px; }
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-thumb { background:var(--line-strong); border-radius:8px; border:3px solid transparent; background-clip:padding-box; }
  ::-webkit-scrollbar-thumb:hover { background:var(--muted); background-clip:padding-box; border:3px solid transparent; }

  #app { display: flex; height: 100vh; }

  /* sidebar */
  .sidebar { width:268px; flex:none; background:var(--sidebar); border-right:1px solid var(--line);
    display:flex; flex-direction:column; position:relative; transition:margin-left .22s cubic-bezier(.4,0,.2,1); }
  .sb-resizer { position:absolute; top:0; right:-3px; width:6px; height:100%; cursor:col-resize; z-index:5; }
  .sb-head { display:flex; align-items:center; gap:8px; padding:14px 14px 10px; }
  .brand { display:flex; align-items:center; gap:8px; flex:1; font-weight:700; font-size:15px; letter-spacing:-.01em; }
  .brand .mark { width:24px; height:24px; border-radius:7px; background:linear-gradient(135deg,var(--accent),#8b94ff);
    display:grid; place-items:center; color:#fff; box-shadow:var(--shadow-sm); }
  .brand .mark svg { width:15px; height:15px; stroke:#fff; }
  .sb-search { margin:0 12px 8px; display:flex; align-items:center; gap:7px; cursor:text;
    background:var(--bg); border:1px solid var(--line); border-radius:var(--radius-sm); padding:6px 9px; color:var(--muted);
    box-shadow:var(--shadow-sm); transition:border-color .15s; }
  .sb-search:focus-within { border-color:var(--accent); }
  .sb-search input { border:0; background:none; outline:none; color:var(--fg); width:100%; }
  .sb-search kbd { font-family:var(--mono); font-size:10px; color:var(--muted); border:1px solid var(--line-strong); border-radius:4px; padding:1px 4px; }
  .sb-scroll { flex:1; overflow-y:auto; padding:4px 8px 24px; }
  .sb-section { margin-top:12px; }
  .sb-section-head { display:flex; align-items:center; justify-content:space-between;
    font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); padding:4px 8px; }
  .sb-section-head .add { opacity:0; padding:3px; border-radius:5px; color:var(--muted); transition:opacity .12s; }
  .sb-section:hover .add { opacity:1; }
  .sb-section-head .add:hover { background:var(--hover-2); color:var(--fg); }
  .navitem { display:flex; align-items:center; gap:3px; width:100%; text-align:left; padding:5px 6px; border-radius:var(--radius-sm);
    color:var(--fg-soft); font-size:13.5px; position:relative; white-space:nowrap; transition:background .1s; }
  .navitem:hover { background:var(--hover-2); }
  .navitem.active { background:var(--bg); color:var(--fg); font-weight:600; box-shadow:var(--shadow-sm); }
  .navitem .tw { width:18px; height:18px; display:grid; place-items:center; color:var(--muted); border-radius:4px; flex:none; }
  .navitem .tw:hover { background:var(--hover-2); }
  .navitem .tw svg { width:13px; height:13px; transition:transform .12s; }
  .navitem .tw.open svg { transform:rotate(90deg); }
  .navitem .emoji { width:20px; text-align:center; flex:none; font-size:14px; }
  .navitem .label { flex:1; overflow:hidden; text-overflow:ellipsis; }
  .navitem .acts { display:flex; gap:1px; opacity:0; }
  .navitem:hover .acts { opacity:1; }
  .navitem .acts button { width:22px; height:22px; display:grid; place-items:center; color:var(--muted); border-radius:5px; }
  .navitem .acts button:hover { background:var(--hover-2); color:var(--fg); }
  .navchildren { margin-left:16px; border-left:1px solid var(--line-strong); padding-left:2px; }
  .navitem.drop-into { box-shadow:inset 0 0 0 2px var(--accent); }
  .navitem.drop-before { box-shadow:inset 0 2px 0 0 var(--accent); }
  .navitem.drop-after { box-shadow:inset 0 -2px 0 0 var(--accent); }
  .dragging { opacity:.35; }
  .sb-footer { flex:none; padding:6px 8px; border-top:1px solid var(--line); }
  .sb-footer .navitem { font-size:13.5px; }

  /* settings page */
  .set-page { max-width:680px; margin:0 auto; padding:40px 28px 64px; }
  .set-title { font-size:26px; font-weight:700; letter-spacing:-.02em; color:var(--fg); }
  .set-sub { color:var(--muted); margin-top:4px; }
  .set-section { margin-top:34px; }
  .set-section-head { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-bottom:4px; }
  .set-section-desc { color:var(--fg-soft); margin-bottom:16px; }
  .theme-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .theme-card { position:relative; display:flex; flex-direction:column; align-items:flex-start; gap:10px;
    text-align:left; padding:16px; border:1px solid var(--line-strong); border-radius:var(--radius);
    background:var(--surface); color:var(--fg-soft); box-shadow:var(--shadow-sm);
    transition:border-color .14s, background .14s, transform .14s, box-shadow .14s; }
  .theme-card:hover { border-color:var(--muted); transform:translateY(-1px); }
  .theme-card .tc-ico { width:34px; height:34px; display:grid; place-items:center; border-radius:9px;
    background:var(--surface-2); color:var(--fg); }
  .theme-card .tc-ico svg { width:18px; height:18px; }
  .theme-card .tc-name { font-weight:600; font-size:14px; color:var(--fg); }
  .theme-card .tc-desc { font-size:12px; color:var(--muted); line-height:1.45; }
  .theme-card .tc-check { position:absolute; top:10px; right:10px; width:18px; height:18px; border-radius:50%;
    background:var(--accent); color:var(--accent-fg); display:grid; place-items:center; opacity:0; transform:scale(.6); transition:opacity .14s, transform .14s; }
  .theme-card .tc-check svg { width:12px; height:12px; stroke-width:2.6; }
  .theme-card.sel { border-color:var(--accent); background:var(--accent-soft); box-shadow:0 0 0 1px var(--accent) inset, var(--shadow-sm); }
  .theme-card.sel .tc-ico { background:var(--accent); color:var(--accent-fg); }
  .theme-card.sel .tc-check { opacity:1; transform:scale(1); }
  @media (max-width:560px) { .theme-grid { grid-template-columns:1fr; } }

  /* main */
  .main { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }
  .topbar { display:flex; align-items:center; gap:6px; padding:10px 18px; border-bottom:1px solid var(--line); min-height:49px; }
  .topbar .hamburger { display:none; }
  .topbar .hamburger.show-collapsed { display:grid; }
  .sidebar.collapsed { overflow:hidden; }
  .sidebar.collapsed .sb-resizer { pointer-events:none; }
  .crumb { display:flex; align-items:center; gap:7px; flex:1; min-width:0; font-size:13.5px; color:var(--fg); font-weight:500; }
  .crumb .emoji { font-size:15px; } .crumb .sub { color:var(--muted); font-weight:400; }
  .iconbtn { width:30px; height:30px; display:grid; place-items:center; border-radius:var(--radius-sm); color:var(--fg-soft); transition:background .12s; }
  .iconbtn:hover { background:var(--hover-2); color:var(--fg); }
  .content { flex:1; overflow:auto; }
  .btn { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:var(--radius-sm); font-size:13px; font-weight:500; transition:all .12s; white-space:nowrap; }
  .btn-ghost { color:var(--fg-soft); } .btn-ghost:hover { background:var(--hover-2); color:var(--fg); }
  .btn-secondary { background:var(--bg); border:1px solid var(--line-strong); color:var(--fg); box-shadow:var(--shadow-sm); }
  .btn-secondary:hover { background:var(--surface-2); }
  .btn-primary { background:var(--accent); color:var(--accent-fg); box-shadow:var(--shadow-sm); }
  .btn-primary:hover { filter:brightness(1.07); }
  .btn-danger { background:var(--danger); color:#fff; } .btn-danger:hover { filter:brightness(1.05); }

  /* document editor */
  .doc { max-width:740px; margin:0 auto; padding:60px 60px 36vh; }
  .doc-title { font-size:38px; font-weight:700; letter-spacing:-.02em; outline:none; line-height:1.15; margin-bottom:4px; }
  .doc-title:empty::before { content:"无标题"; color:var(--muted); }
  .doc-meta { display:flex; gap:14px; color:var(--muted); font-size:12.5px; margin-bottom:22px; }
  .doc-meta span { display:inline-flex; align-items:center; gap:5px; }
  .doc.source-mode { min-height:100%; }
  .doc-source { display:block; width:100%; min-height:calc(100vh - 210px); resize:none; border:0;
    background:transparent; color:var(--fg); outline:none; overflow:hidden; padding:3px 2px 36vh;
    font-family:var(--ui); font-size:15px; line-height:1.7; tab-size:2; }
  .block-wrap { position:relative; }
  .block-wrap.nested { padding-left:24px; }
  /* Subtle indent guide only for true sub-lists; suppressed for code/other
     nested content so code-in-list items don't stack a thicket of lines. */
  .block-wrap.nested:has(> .block.b-bullet, > .block.b-numbered, > .block.b-todo)::before {
    content:""; position:absolute; left:8px; top:2px; bottom:2px; width:1px; background:var(--line); }
  .block { position:relative; display:flex; align-items:flex-start; padding:1px 0; border-radius:4px; }
  .block .gutter { position:absolute; left:-52px; top:2px; display:flex; gap:1px; opacity:0; transition:opacity .12s; }
  .block:hover .gutter, .block.drop-before .gutter, .block.drop-after .gutter, .block.dragging .gutter { opacity:1; }
  .gutter button { width:22px; height:24px; display:grid; place-items:center; color:var(--muted); border-radius:5px; }
  .gutter button:hover { background:var(--hover-2); color:var(--fg); }
  .gutter .grip { cursor:grab; } .gutter .grip:active { cursor:grabbing; }
  .block.dragging { opacity:.42; background:var(--hover); }
  .block.drop-before::before, .block.drop-after::after { content:""; position:absolute; left:0; right:0; height:2px; background:var(--accent);
    border-radius:2px; pointer-events:none; box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 18%,transparent); }
  .block.drop-before::before { top:-1px; }
  .block.drop-after::after { bottom:-1px; }
  /* multi-block selection: whole-block tint + suppress stray native text highlight while dragging */
  .block.selected { background:var(--accent-soft); }
  .block.selected .editable::selection, .block.selected .editable *::selection { background:transparent; }
  .doc.selecting, .doc.selecting * { user-select:none; -webkit-user-select:none; cursor:default; }
  .block.list-code-host { height:0; min-height:0; padding:0; overflow:visible; }
  .block-wrap:hover > .block.list-code-host .gutter { opacity:1; }
  .block.list-code-host .marker { position:absolute; left:0; top:0; padding-top:4px; z-index:1; }
  /* The list item's host gutter controls the whole unit, so suppress the nested
     code block's own gutter (it would overlap the list marker on the same row). */
  .block.list-code-host + .block-wrap.nested .gutter { display:none; }
  .editable { outline:none; flex:1; min-width:0; padding:3px 2px; line-height:1.6; }
  .editable:empty::before { content:attr(data-ph); color:var(--muted); pointer-events:none; }
  .b-h1 .editable { font-size:28px; font-weight:700; letter-spacing:-.02em; padding-top:12px; }
  .b-h2 .editable { font-size:22px; font-weight:650; letter-spacing:-.01em; padding-top:8px; }
  .b-h3 .editable { font-size:18px; font-weight:600; padding-top:4px; }
  .b-h1 .gutter { top:22px; } .b-h2 .gutter { top:14px; } .b-h3 .gutter { top:7px; }
  .b-quote .editable { border-left:3px solid var(--line-strong); padding:1px 0 1px 16px; color:var(--fg-soft); font-style:italic; }

  /* code block: transparent textarea over a highlight.js mirror */
  .b-code .codeblock { flex:1; min-width:0; }
  .codeblock { position:relative; --code-fs:12.5px; --code-lh:1.55; --code-pad:8px; margin:2px 0;
    background:var(--code-bg); border:1px solid var(--line); border-radius:8px; overflow:hidden; box-shadow:var(--shadow-sm); }
  /* lang + copy float bottom-right, revealed on hover */
  .code-tools { position:absolute; right:6px; bottom:6px; z-index:2; display:flex; align-items:center; gap:1px;
    padding:2px; border-radius:7px; border:1px solid var(--line); box-shadow:var(--shadow-sm);
    background:color-mix(in srgb,var(--code-bg) 82%,transparent); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
    opacity:0; transform:translateY(3px); pointer-events:none; transition:opacity .12s,transform .12s; }
  .codeblock:hover .code-tools, .code-tools:focus-within { opacity:1; transform:none; pointer-events:auto; }
  .code-lang { position:relative; display:inline-flex; align-items:center; }
  .code-lang select { appearance:none; -webkit-appearance:none; border:0; outline:none; background:none; cursor:pointer;
    font-family:var(--mono); font-size:10.5px; font-weight:500; color:var(--fg-soft); padding:3px 17px 3px 7px; border-radius:5px; }
  .code-lang select:hover { background:var(--hover-2); }
  .code-lang svg { position:absolute; right:3px; width:12px; height:12px; pointer-events:none; color:var(--muted); }
  .code-copy { display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:500; color:var(--muted);
    padding:3px 7px; border-radius:5px; transition:background .12s,color .12s; }
  .code-copy:hover { background:var(--hover-2); color:var(--fg-soft); }
  .code-copy.ok { color:var(--accent); }
  .code-body { display:flex; align-items:stretch; font-family:var(--mono); font-size:var(--code-fs); line-height:var(--code-lh); }
  .code-gutter { flex:none; text-align:right; white-space:pre; user-select:none; color:var(--muted); opacity:.55;
    padding:var(--code-pad) 8px var(--code-pad) 12px; border-right:1px solid var(--line); font-variant-numeric:tabular-nums; }
  .code-scroll { position:relative; flex:1; min-width:0; }
  .code-hl, .code-input { margin:0; font-family:var(--mono); font-size:var(--code-fs); line-height:var(--code-lh);
    padding:var(--code-pad) 16px; tab-size:2; -moz-tab-size:2; white-space:pre; letter-spacing:0; }
  .code-hl { position:absolute; inset:0; z-index:0; overflow:hidden; pointer-events:none; background:none; color:var(--fg); }
  .code-hl code { display:block; font:inherit; background:none; padding:0; }
  .code-input { display:block; position:relative; z-index:1; width:100%; border:0; outline:none; resize:none;
    overflow-x:auto; overflow-y:hidden; background:transparent; color:transparent; caret-color:var(--fg);
    min-height:calc(var(--code-fs) * var(--code-lh) + var(--code-pad) * 2); }
  .code-input::placeholder { color:var(--muted); }

  /* highlight.js token theme (cohesive with the app palette) */
  .hljs-comment, .hljs-quote { color:var(--hl-cmt); font-style:italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-doctag { color:var(--hl-key); }
  .hljs-string, .hljs-regexp, .hljs-addition, .hljs-meta .hljs-string { color:var(--hl-str); }
  .hljs-number, .hljs-bullet { color:var(--hl-num); }
  .hljs-title, .hljs-title.function_, .hljs-name, .hljs-selector-id, .hljs-selector-class { color:var(--hl-fn); }
  .hljs-type, .hljs-class .hljs-title, .hljs-built_in, .hljs-attr, .hljs-attribute, .hljs-property { color:var(--hl-type); }
  .hljs-variable, .hljs-template-variable, .hljs-symbol, .hljs-tag, .hljs-meta, .hljs-link { color:var(--hl-var); }
  .hljs-deletion { color:var(--danger); }
  .hljs-params, .hljs-subst { color:var(--fg); }
  .hljs-emphasis { font-style:italic; }
  .hljs-strong { font-weight:700; }
  .marker { width:24px; flex:none; text-align:center; color:var(--fg-soft); user-select:none; padding-top:4px; }
  .b-todo .marker { padding-top:5px; }
  .b-todo .marker input { width:15px; height:15px; accent-color:var(--accent); cursor:pointer; }
  .b-divider { padding:10px 0; }
  .b-divider hr { border:0; border-top:1px solid var(--line-strong); margin:0; width:100%; }
  .b-done .editable { color:var(--muted); text-decoration:line-through; }
  .editable b, .editable strong { font-weight:700; }
  .editable code { font-family:var(--mono); background:var(--surface-2); padding:1px 5px; border-radius:4px; font-size:.9em; }
  .editable a { color:var(--accent); }

  /* document table (GFM pipe table block) */
  .b-table .doc-table-wrap { flex:1; min-width:0; margin:4px 0; }
  .doc-table-scroll { overflow-x:auto; padding:2px 0; }
  .doc-table-inner { width:max-content; }
  .doc-table-row { display:flex; align-items:stretch; }
  table.doc-table { border-collapse:separate; border-spacing:0; table-layout:fixed; width:max-content;
    border:1px solid var(--line); border-radius:var(--radius-sm); overflow:hidden; box-shadow:var(--shadow-sm); }
  table.doc-table td { position:relative; vertical-align:top; padding:0;
    border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
  table.doc-table tr td:last-child { border-right:0; }
  table.doc-table tr:last-child td { border-bottom:0; }
  table.doc-table .doc-th { background:var(--surface); }
  .doc-td { outline:none; padding:7px 22px 7px 10px; min-height:20px; line-height:1.55; word-break:break-word; white-space:pre-wrap; }
  .doc-th .doc-td { font-weight:650; color:var(--fg); }
  .doc-td:empty::before { content:attr(data-ph); color:var(--muted); pointer-events:none; }
  .doc-td b, .doc-td strong { font-weight:700; }
  .doc-td code { font-family:var(--mono); background:var(--surface-2); padding:1px 5px; border-radius:4px; font-size:.9em; }
  .doc-td a { color:var(--accent); }
  /* header cell: column menu + resize handle */
  .doc-col-menu { position:absolute; top:4px; right:4px; width:18px; height:18px; display:grid; place-items:center;
    color:var(--muted); border-radius:4px; opacity:0; transition:opacity .12s,background .12s; }
  .doc-th:hover .doc-col-menu { opacity:1; }
  .doc-col-menu:hover { background:var(--hover-2); color:var(--fg); }
  .doc-col-resizer { position:absolute; top:0; right:-3px; width:7px; height:100%; cursor:col-resize; z-index:3; touch-action:none; }
  .doc-col-resizer:hover, .doc-col-resizer.dragging { background:var(--accent); opacity:.35; }
  /* per-row delete: small handle floating at the first cell on row hover */
  .doc-row-del { position:absolute; top:3px; left:2px; width:18px; height:18px; display:grid; place-items:center;
    color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:5px; box-shadow:var(--shadow-sm);
    opacity:0; transition:opacity .12s; }
  table.doc-table tr:hover .doc-row-del { opacity:1; }
  .doc-row-del:hover { background:var(--danger-soft); color:var(--danger); border-color:var(--danger-soft); }
  /* add-column (right edge) and add-row (bottom edge) buttons */
  .doc-table-addcol { width:22px; margin-left:4px; flex:none; display:grid; place-items:center; color:var(--muted);
    border:1px dashed var(--line-strong); border-radius:var(--radius-sm); background:var(--surface); transition:background .12s,color .12s,border-color .12s; }
  .doc-table-addrow { width:100%; height:22px; margin-top:4px; display:grid; place-items:center; color:var(--muted);
    border:1px dashed var(--line-strong); border-radius:var(--radius-sm); background:var(--surface); transition:background .12s,color .12s,border-color .12s; }
  .doc-table-addcol:hover, .doc-table-addrow:hover { background:var(--accent-soft); color:var(--accent); border-color:var(--accent); }

  /* database / table */
  .db { padding:22px 36px 90px; min-width:0; }
  .db-head { display:flex; align-items:center; gap:12px; }
  .db-icon { width:38px; height:38px; border-radius:9px; background:var(--surface-2); display:grid; place-items:center; font-size:20px; }
  .db-title { font-size:27px; font-weight:700; letter-spacing:-.02em; outline:none; }
  .db-desc { color:var(--muted); font-size:13px; margin-top:2px; }
  .views { display:flex; align-items:center; gap:2px; border-bottom:1px solid var(--line); margin:16px 0 0; }
  .view-tab { display:flex; align-items:center; gap:6px; padding:8px 11px; font-size:13.5px; font-weight:500; color:var(--muted);
    border-bottom:2px solid transparent; margin-bottom:-1px; transition:color .12s; }
  .view-tab.active { color:var(--fg); border-bottom-color:var(--accent); }
  .view-tab:hover { color:var(--fg); } .view-tab svg { width:14px; height:14px; }
  .toolbar { display:flex; align-items:center; gap:2px; padding:10px 0; }
  .toolbar .spacer { flex:1; }
  .tbtn { display:flex; align-items:center; gap:6px; padding:5px 9px; border-radius:var(--radius-sm); color:var(--fg-soft); font-size:13px; font-weight:500; }
  .tbtn:hover { background:var(--hover-2); color:var(--fg); }
  .tbtn.on { color:var(--accent); }
  .tablewrap { border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow-sm); }
  .tablescroll { overflow-x:auto; }
  /* fixed layout + max-content: each <col> width is authoritative, so the table
     is exactly the sum of its columns and resizing one column never redistributes
     width to its neighbours. min-width:100% fills the container when columns are
     narrow, with the slack absorbed only by the trailing auto (filler) column. */
  table.grid { border-collapse:collapse; table-layout:fixed; width:max-content; min-width:100%; }
  table.grid th, table.grid td { border-right:1px solid var(--line); border-bottom:1px solid var(--line); padding:0; text-align:left; }
  table.grid th:last-child, table.grid td:last-child { border-right:0; }
  table.grid tbody tr:last-child td { border-bottom:0; }
  thead th { background:var(--surface); position:relative; user-select:none; font-weight:600; color:var(--fg-soft); }
  .colhead { display:flex; align-items:center; gap:7px; padding:9px 11px; font-size:13px; cursor:pointer; }
  .colhead:hover { background:var(--hover); }
  .colhead .ti { color:var(--muted); } .colhead .ti svg { width:14px; height:14px; }
  .colhead .nm { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .col-resizer { position:absolute; top:0; right:-3px; width:7px; height:100%; cursor:col-resize; z-index:2; touch-action:none; }
  .col-resizer:hover, .col-resizer.dragging { background:var(--accent); opacity:.35; }
  .addcol { min-width:46px; } .addcol .colhead { justify-content:flex-start; color:var(--muted); }
  /* trailing filler column: empty canvas to the right of the data, not a real cell */
  table.grid td.filler { border-right:0; border-bottom:0; background:transparent; }
  body.col-resizing { user-select:none; cursor:col-resize; }
  table.grid .selcell { width:38px; min-width:38px; max-width:38px; text-align:center; }
  table.grid .gripcol, table.grid .rowgrip { width:26px; min-width:26px; max-width:26px; text-align:center; }
  td.cell-td { vertical-align:top; }
  .cell { padding:8px 11px; min-height:37px; cursor:text; word-break:break-word; display:flex; flex-wrap:wrap; gap:3px; align-items:center; }
  /* hover/active tint goes on the <td> (always full row height) not the inner
     .cell (only as tall as its content), so a taller sibling row never leaves a
     gap of un-tinted space at the bottom of the hovered cell. */
  td.cell-td { transition:background .1s; }
  td.cell-td:hover { background:var(--hover); } .cell.center { justify-content:center; }
  tbody tr { transition:background .08s; }
  tbody tr:hover { background:var(--hover); }
  tbody tr.sel { background:var(--accent-soft); }
  /* cell range selection: per-cell fill; the accent rectangle outline is drawn via inline box-shadow on edge cells. Placed after :hover so it wins on equal specificity. */
  td.cell-td.cellsel, td.cell-td.cellsel:hover { background:var(--accent-soft); }
  body.cell-selecting { user-select:none; cursor:cell; }
  body.cell-selecting .cell { cursor:cell; }
  table.grid tr.drop-before td { box-shadow:inset 0 2px 0 0 var(--accent); }
  table.grid tr.drop-after td { box-shadow:inset 0 -2px 0 0 var(--accent); }
  table.grid th.drop-before { box-shadow:inset 2px 0 0 0 var(--accent); }
  table.grid th.drop-after { box-shadow:inset -2px 0 0 0 var(--accent); }
  .rowgrip { color:transparent; cursor:grab; vertical-align:middle; touch-action:none; }
  .rowgrip[aria-disabled="true"] { cursor:not-allowed; }
  tbody tr:hover .rowgrip { color:var(--muted); }
  .colhead { touch-action:none; }
  .drag-source { opacity:.35; }
  body.table-dragging { user-select:none; cursor:grabbing; }
  .drag-ghost { position:fixed; left:0; top:0; z-index:120; pointer-events:none; display:flex; align-items:center;
    padding:7px 11px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; border:1px solid var(--line-strong);
    border-radius:7px; background:var(--bg); color:var(--fg); box-shadow:var(--shadow-lg); opacity:.94; font-size:13px; }
  .row-ghost { min-height:34px; }
  .col-ghost { justify-content:center; font-weight:600; color:var(--fg-soft); background:var(--surface); }
  .selcell { vertical-align:middle; }
  .selcell input { width:15px; height:15px; accent-color:var(--accent); opacity:0; cursor:pointer; vertical-align:middle; }
  tbody tr:hover .selcell input, tbody tr.sel .selcell input, .selcell input:checked, thead .selcell input { opacity:1; }
  .firstcell { position:relative; width:100%; min-width:0; }
  /* row actions float over the cell on hover, never reserving column width */
  /* right:-5px pulls the button out over the cell's 11px right padding so it
     sits ~6px from the column border instead of ~15px inside it */
  .rowactions { position:absolute; top:0; bottom:0; right:-5px; display:flex; align-items:flex-start;
    padding:1px 0 0; opacity:0; pointer-events:none; }
  tbody tr:hover .rowactions { opacity:1; pointer-events:auto; }
  /* square icon button — "open as page" (Notion-style) */
  .rowopen { width:23px; height:23px; flex:none; display:inline-flex; align-items:center; justify-content:center;
    border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg-soft); box-shadow:var(--shadow-sm); }
  .rowopen:hover { background:var(--surface-2); color:var(--fg); border-color:var(--line-strong); }
  .rowopen svg { width:14px; height:14px; }
  .chip { display:inline-flex; align-items:center; gap:4px; border-radius:5px; padding:2px 8px; font-size:12.5px; font-weight:500; white-space:nowrap;
    background:color-mix(in srgb,var(--c) 15%,transparent); color:var(--c); }
  @media (prefers-color-scheme: dark) { .chip { background:color-mix(in srgb,var(--c) 22%,transparent); color:color-mix(in srgb,var(--c) 75%,#fff); } }
  .addrow { display:flex; align-items:center; gap:7px; padding:9px 12px; color:var(--muted); font-size:13px; cursor:pointer; border-top:1px solid var(--line); }
  .addrow:hover { background:var(--hover); color:var(--fg-soft); }
  .gridfoot { display:flex; gap:18px; color:var(--muted); font-size:12px; padding:8px 2px; }
  input.inlineedit { width:100%; border:0; outline:2px solid var(--accent); border-radius:4px; padding:7px 9px; background:var(--bg); color:var(--fg); font:inherit; }

  .selbar { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:65; display:flex; align-items:center; gap:4px;
    background:var(--fg); color:var(--bg); padding:7px 8px 7px 14px; border-radius:11px; box-shadow:var(--shadow-lg); }
  .selbar .cnt { font-size:13px; font-weight:600; margin-right:6px; }
  .selbar button { display:flex; align-items:center; gap:6px; color:var(--bg); padding:6px 10px; border-radius:7px; font-size:13px; font-weight:500; }
  .selbar button:hover { background:rgba(127,127,127,.25); }
  .selbar .del:hover { background:var(--danger); color:#fff; }

  /* record peek */
  .scrim { position:fixed; inset:0; background:rgba(15,15,25,.32); z-index:70; opacity:0; pointer-events:none; transition:opacity .22s; }
  .scrim.open { opacity:1; pointer-events:auto; }
  .peek { position:fixed; top:0; right:0; width:580px; max-width:94vw; height:100%; background:var(--bg); border-left:1px solid var(--line);
    box-shadow:var(--shadow-lg); z-index:71; transform:translateX(100%); transition:transform .24s cubic-bezier(.32,.72,0,1); display:flex; flex-direction:column; }
  .peek.open { transform:none; }
  .peek-head { display:flex; align-items:center; gap:4px; padding:12px 16px; border-bottom:1px solid var(--line); }
  .peek-body { overflow:auto; padding:28px 32px; }
  .peek h2 { font-size:27px; font-weight:700; letter-spacing:-.02em; margin:0 0 20px; outline:none; }
  .proprow { display:flex; gap:8px; align-items:flex-start; margin:1px 0; }
  .proprow .k { width:160px; flex:none; color:var(--muted); display:flex; align-items:center; gap:7px; font-size:13px; padding:7px 8px; border-radius:var(--radius-sm); }
  .proprow .k:hover { background:var(--hover); }
  .proprow .v { flex:1; padding:7px 8px; border-radius:var(--radius-sm); cursor:text; min-height:33px; display:flex; flex-wrap:wrap; gap:3px; align-items:center; }
  .proprow .v:hover { background:var(--hover); }
  .peek-divider { height:1px; background:var(--line); margin:22px 0 18px; }

  /* menu / popover */
  .menu-layer { position:fixed; inset:0; z-index:90; }
  .pop { position:fixed; background:var(--bg); border:1px solid var(--line); border-radius:11px; box-shadow:var(--shadow-lg);
    padding:6px; min-width:232px; max-height:70vh; overflow:auto; animation:pop .12s ease; }
  @keyframes pop { from { opacity:0; transform:translateY(-4px); } }
  .pop .lbl { font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; padding:6px 8px 3px; }
  .pop .item { display:flex; align-items:center; gap:10px; padding:7px 8px; border-radius:var(--radius-sm); width:100%; text-align:left; color:var(--fg); font-size:13.5px; }
  .pop .item:hover, .pop .item.sel { background:var(--hover-2); }
  .pop .item .lico { width:28px; height:28px; display:grid; place-items:center; border:1px solid var(--line); border-radius:6px; color:var(--fg-soft); flex:none; }
  .pop .item .lico.plain { border:0; width:22px; height:22px; }
  .pop .item .meta { flex:1; min-width:0; }
  .pop .item .t { font-size:13.5px; } .pop .item .d { font-size:11.5px; color:var(--muted); display:block; }
  .pop .item .chk { color:var(--accent); margin-left:auto; }
  .pop .item.danger { color:var(--danger); } .pop .item.danger .lico { color:var(--danger); }
  .pop .sep { height:1px; background:var(--line); margin:5px 4px; }
  .pop .typegrid { display:grid; grid-template-columns:repeat(4,1fr); gap:4px; padding:2px 2px 4px; }
  .pop .typegrid .item { flex-direction:column; gap:5px; padding:9px 4px; text-align:center; }
  .pop .typegrid .item .lico { margin:0 auto; }
  .pop input.field { width:100%; border:1px solid var(--line-strong); border-radius:var(--radius-sm); padding:7px 9px; outline:none; background:var(--surface); margin:2px; }
  .pop input.field:focus { border-color:var(--accent); }
  .optrow { display:flex; align-items:center; gap:6px; padding:3px 4px; }
  .optrow .chip { flex:1; }
  .optrow .x { width:22px; height:22px; display:grid; place-items:center; color:var(--muted); border-radius:5px; }
  .optrow .x:hover { background:var(--hover-2); color:var(--danger); }

  /* modal */
  .modal-scrim { position:fixed; inset:0; background:rgba(15,15,25,.4); z-index:100; display:grid; place-items:center;
    opacity:0; pointer-events:none; transition:opacity .15s; padding:20px; }
  .modal-scrim.open { opacity:1; pointer-events:auto; }
  .modal { background:var(--bg); border-radius:16px; box-shadow:var(--shadow-lg); width:440px; max-width:100%; overflow:hidden; }
  .modal-head { padding:20px 22px 0; }
  .modal-head h3 { margin:0; font-size:18px; font-weight:700; letter-spacing:-.01em; }
  .modal-head p { margin:6px 0 0; color:var(--muted); font-size:13.5px; }
  .modal-body { padding:18px 22px; }
  .modal-foot { display:flex; justify-content:flex-end; gap:8px; padding:14px 22px; background:var(--surface); border-top:1px solid var(--line); }
  .field-label { font-size:12px; font-weight:600; color:var(--fg-soft); margin:12px 0 5px; }
  .field-label:first-child { margin-top:0; }
  .text-input { width:100%; border:1px solid var(--line-strong); border-radius:var(--radius-sm); padding:9px 11px; outline:none; background:var(--surface); font-size:14px; }
  .text-input:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  .icon-pick { display:flex; gap:6px; flex-wrap:wrap; }
  .icon-pick button { width:38px; height:38px; border-radius:9px; border:1px solid var(--line); font-size:19px; display:grid; place-items:center; }
  .icon-pick button:hover { background:var(--hover-2); }
  .icon-pick button.sel { border-color:var(--accent); background:var(--accent-soft); }
  .tmpl { display:flex; gap:8px; }
  .tmpl button { flex:1; border:1px solid var(--line); border-radius:var(--radius); padding:12px; text-align:left; }
  .tmpl button:hover { border-color:var(--accent); background:var(--surface); }
  .tmpl button.sel { border-color:var(--accent); background:var(--accent-soft); }
  .tmpl .tt { font-weight:600; font-size:13.5px; } .tmpl .td { font-size:11.5px; color:var(--muted); margin-top:2px; }

  /* toast */
  .toasts { position:fixed; bottom:20px; left:20px; z-index:110; display:flex; flex-direction:column; gap:8px; }
  .toast { background:var(--fg); color:var(--bg); padding:10px 14px; border-radius:9px; font-size:13px; box-shadow:var(--shadow-lg);
    display:flex; align-items:center; gap:8px; animation:slidein .2s ease; }
  @keyframes slidein { from { opacity:0; transform:translateX(-12px); } }

  /* misc */
  .empty { display:grid; place-items:center; height:100%; color:var(--muted); text-align:center; padding:40px; }
  .error-bar { margin:12px 24px; padding:10px 14px; background:var(--danger-soft); color:var(--danger); border-radius:var(--radius-sm); font-size:13px; cursor:pointer; }
  .view-placeholder { padding:40px; text-align:center; border:1px dashed var(--line-strong); border-radius:var(--radius); color:var(--muted); margin-top:8px; }
  .ico.flip { transform:scaleX(-1); }

  /* ---- board (kanban) view ---- */
  .board-wrap { margin-top:4px; }
  .board-bar { display:flex; align-items:center; gap:10px; padding:2px 0 12px; }
  .board { display:flex; align-items:flex-start; gap:12px; overflow-x:auto; padding-bottom:14px; min-height:240px; }
  .board-col { flex:0 0 272px; width:272px; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); display:flex; flex-direction:column; max-height:calc(100vh - 240px); transition:box-shadow .12s,border-color .12s; }
  .board-col.drop-into { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }
  .board-col-head { display:flex; align-items:center; gap:8px; padding:10px 10px 8px; }
  .board-col-head .spacer { flex:1; }
  .board-count { color:var(--muted); font-size:12px; font-weight:600; }
  .board-col-head .iconbtn.sm { width:24px; height:24px; }
  .board-col-body { display:flex; flex-direction:column; gap:7px; padding:0 8px 8px; overflow-y:auto; }
  .kcard { background:var(--bg); border:1px solid var(--line); border-radius:var(--radius-sm); padding:9px 10px; box-shadow:var(--shadow-sm);
    cursor:pointer; display:flex; flex-direction:column; gap:5px; touch-action:none; transition:border-color .1s,box-shadow .1s; }
  .kcard:hover { border-color:var(--line-strong); }
  .kcard-title { font-size:13.5px; font-weight:600; line-height:1.35; word-break:break-word; }
  .kcard-field { display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--fg-soft); min-width:0; }
  .kcard-field svg { width:13px; height:13px; color:var(--muted); flex:none; }
  .board-add { display:flex; align-items:center; gap:6px; padding:7px 8px; color:var(--muted); font-size:12.5px; border-radius:var(--radius-sm); }
  .board-add:hover { background:var(--hover-2); color:var(--fg-soft); }

  /* ---- calendar (month) view ---- */
  .cal { margin-top:4px; display:flex; flex-direction:column; }
  .cal-nav { display:flex; align-items:center; gap:8px; padding:2px 0 12px; }
  .cal-nav .spacer { flex:1; }
  .cal-title { font-size:15px; font-weight:650; min-width:120px; }
  .cal-grid { display:grid; grid-template-columns:repeat(7,1fr); }
  .cal-head { border:1px solid var(--line); border-bottom:0; border-radius:var(--radius) var(--radius) 0 0; background:var(--surface); }
  .cal-wd { padding:8px 10px; font-size:12px; font-weight:600; color:var(--muted); text-align:left; border-right:1px solid var(--line); }
  .cal-wd:last-child { border-right:0; }
  .cal-body { border:1px solid var(--line); border-radius:0 0 var(--radius) var(--radius); overflow:hidden; }
  .cal-week { border-bottom:1px solid var(--line); }
  .cal-week:last-child { border-bottom:0; }
  .cal-day { min-height:108px; border-right:1px solid var(--line); padding:5px 6px; display:flex; flex-direction:column; gap:4px; transition:background .1s; }
  .cal-day:last-child { border-right:0; }
  .cal-day.dim { background:var(--surface); color:var(--muted); }
  .cal-day.drop-into { background:var(--accent-soft); }
  .cal-daynum { display:flex; align-items:center; justify-content:space-between; font-size:12.5px; font-weight:600; color:var(--fg-soft); }
  .cal-day.dim .cal-daynum { color:var(--muted); }
  .cal-day.today .cal-daynum span:first-child { background:var(--accent); color:var(--accent-fg); width:21px; height:21px; border-radius:50%; display:grid; place-items:center; }
  .cal-add { opacity:0; width:20px; height:20px; display:grid; place-items:center; color:var(--muted); border-radius:5px; transition:opacity .12s; }
  .cal-day:hover .cal-add { opacity:1; }
  .cal-add:hover { background:var(--hover-2); color:var(--fg); }
  .cal-events { display:flex; flex-direction:column; gap:3px; }
  .cal-ev { font-size:12px; padding:2px 7px; border-radius:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; touch-action:none;
    background:color-mix(in srgb,var(--c) 16%,transparent); color:var(--c); border-left:2px solid var(--c); }
  @media (prefers-color-scheme: dark) { .cal-ev { background:color-mix(in srgb,var(--c) 24%,transparent); color:color-mix(in srgb,var(--c) 78%,#fff); } }
  .cal-more { font-size:11.5px; color:var(--muted); padding:1px 7px; }

  /* ---- timeline (gantt) view ---- */
  .tl { margin-top:4px; }
  .tl-toolbar { display:flex; align-items:center; gap:8px; padding:2px 0 12px; }
  .tl-scroll { overflow:auto; border:1px solid var(--line); border-radius:var(--radius); max-height:calc(100vh - 230px); }
  .tl-canvas { position:relative; }
  .tl-axis { position:sticky; top:0; z-index:4; background:var(--surface); border-bottom:1px solid var(--line); }
  .tl-corner { position:sticky; left:0; z-index:5; height:100%; display:flex; align-items:center; padding:0 12px; font-size:12px; font-weight:600; color:var(--muted);
    background:var(--surface); border-right:1px solid var(--line); }
  .tl-tick { position:absolute; top:0; height:100%; box-sizing:border-box; border-right:1px solid var(--line); display:flex; flex-direction:column; justify-content:flex-end; padding:0 0 4px 4px; }
  .tl-tick.mstart { border-right-color:var(--line-strong); }
  .tl-tick .tl-month { position:absolute; top:5px; left:4px; font-size:10.5px; font-weight:700; color:var(--fg-soft); white-space:nowrap; }
  .tl-tick .tl-dnum { font-size:11px; color:var(--muted); }
  .tl-tick.today .tl-dnum { color:var(--accent); font-weight:700; }
  .tl-row { position:absolute; left:0; right:0; border-bottom:1px solid var(--line); }
  .tl-rowlabel { position:sticky; left:0; z-index:3; height:100%; display:flex; align-items:center; padding:0 12px; font-size:13px; font-weight:500;
    background:var(--bg); border-right:1px solid var(--line); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tl-item { position:absolute; top:7px; height:22px; box-sizing:border-box; background:var(--accent); color:var(--accent-fg); border-radius:6px;
    display:flex; align-items:center; gap:2px; padding:0 4px; cursor:grab; touch-action:none; box-shadow:var(--shadow-sm); overflow:hidden; }
  .tl-item .tl-label { flex:1; font-size:12px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none; }
  .tl-item .tl-h { width:7px; align-self:stretch; flex:none; cursor:col-resize; border-radius:6px; }
  .tl-item .tl-h:hover { background:rgba(255,255,255,.4); }
  .tl-milestone { position:absolute; top:9px; width:18px; height:18px; transform:rotate(45deg); background:var(--accent); border-radius:3px; cursor:grab; touch-action:none; box-shadow:var(--shadow-sm); margin-left:-9px; }
  .tl-unscheduled { position:absolute; top:0; height:100%; display:flex; align-items:center; font-size:12px; color:var(--muted); }
  .tl-today { position:absolute; top:0; width:2px; background:var(--accent); opacity:.55; z-index:2; pointer-events:none; }

  /* mobile */
  .backdrop { display:none; }
  @media (max-width: 768px) {
    .sidebar { position:fixed; z-index:80; height:100%; margin-left:-300px; }
    .sidebar.open { margin-left:0; box-shadow:var(--shadow-lg); }
    .backdrop { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:79; }
    .backdrop.show { display:block; }
    .topbar .hamburger { display:grid; }
    .sb-resizer { display:none; }
    .doc { padding:28px 20px 36vh; } .doc-title { font-size:30px; }
    .block .gutter { display:none; }
    .db { padding:16px 14px 90px; }
    .peek { width:100%; }
  }
</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="/webui.js"></script>
</body>
</html>`;

let cachedJs: string | null = null;

/** Resolve the app bundle: prefer a prebuilt dist/webui.js next to the running
 *  file; in dev (running from source) build it on first request and cache. */
async function getJs(): Promise<string> {
  if (cachedJs != null) return cachedJs;

  const prebuilt = Bun.file(fileURLToPath(new URL("./webui.js", import.meta.url)));
  if (await prebuilt.exists()) {
    cachedJs = await prebuilt.text();
    return cachedJs;
  }

  const entry = fileURLToPath(new URL("../../webui/app.tsx", import.meta.url));
  const res = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
  if (!res.success) throw new AggregateError(res.logs, "webui build failed");
  cachedJs = await res.outputs[0]!.text();
  return cachedJs;
}

/** Handle WebUI asset requests. Returns null for anything else so the caller
 *  can fall through to the API routes. */
export async function serveWebui(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const { pathname } = new URL(req.url);

  if (pathname === "/") {
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (pathname === "/webui.js") {
    try {
      return new Response(await getJs(), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    } catch (e) {
      return new Response(`webui build failed: ${e}`, { status: 500 });
    }
  }
  return null;
}
