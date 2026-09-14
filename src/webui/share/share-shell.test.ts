import { test, expect } from "bun:test";
import { shellHtml, SHELL_CSS, SKELETON_HTML } from "./share-shell.ts";

test("shell never shows loading text; the skeleton is the first paint", () => {
  const html = shellHtml();
  const visible = html.replace(/aria-label="[^"]*"/g, "").replace(/<style>[\s\S]*?<\/style>/, "");
  expect(visible).not.toContain("加载中");
  expect(visible).not.toContain("正在加载");
  expect(html).toMatch(/<div id="app"><div class="skel" role="status" aria-busy="true"/);
  expect(html).toContain('<script type="module" src="./share-viewer.js">');
});

test("skeleton mirrors the page: header rule, prose lines, one card", () => {
  expect(SKELETON_HTML).toMatch(/<header class="mh"><span class="skel-b skel-h"/);
  expect(SKELETON_HTML.match(/skel-l/g)?.length).toBe(8);
  expect(SKELETON_HTML.match(/skel-card/g)?.length).toBe(1);
  expect(SKELETON_HTML.match(/skel-h2/g)?.length).toBe(1);
});

test("css: 120ms gated fade-in, sheen sweep, reduced-motion off switch", () => {
  expect(SHELL_CSS).toContain(".skel{animation:skel-in .25s ease .12s both}");
  expect(SHELL_CSS).toContain("@keyframes skel-sweep");
  expect(SHELL_CSS).toContain("@media (prefers-reduced-motion:reduce)");
  expect(SHELL_CSS).toContain("#app>.mh-view{animation:skel-in .18s ease both}");
  expect(SHELL_CSS).toContain("header.mh{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:20px;border-bottom:1px solid var(--line);padding-bottom:14px}");
  expect(SHELL_CSS).toContain(".copy-btn{");
});
