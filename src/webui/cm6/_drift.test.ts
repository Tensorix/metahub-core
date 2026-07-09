import { test } from "bun:test";
import { scanDoc } from "./blockmodel";
import { blocksFromBody, type Block } from "../blocks";

// Flatten blocksFromBody into a set of top-level "void-ish" constructs to compare
// against scanDoc voids. We compare COUNTS of code/html/table/media blocks.
function countVoidish(blocks: Block[]): Record<string, number> {
  const c: Record<string, number> = {};
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (["code", "html", "table", "image", "video", "audio", "file"].includes(b.type)) {
        c[b.type] = (c[b.type] ?? 0) + 1;
      }
      if (b.children) walk(b.children as Block[]);
    }
  };
  walk(blocks);
  return c;
}

function voidCounts(src: string): Record<string, number> {
  const c: Record<string, number> = {};
  for (const v of scanDoc(src).voids) {
    const k = v.block.type;
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}

const rnd = (() => { let a = 0x1234; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();

const VOCAB = [
  "para", "", "- item", "  - nested", "1. one", "2. two", "> quote", "  > q2",
  "# head", "```", "```js", "  ```", "~~~", "~~~~", "code line", "x`y", "```mh-html",
  "<b>hi</b>", "| a | b |", "| --- | --- |", "| 1 | 2 |", "  | a |", "  | --- |",
  "text | pipe", "![i](/blob/p.png?w=9)", "[d.pdf](/blob/d.pdf \"7\")", "---", "````",
];

test("DRIFT: scanDoc voids vs blocksFromBody void-ish counts", () => {
  let mism = 0;
  for (let it = 0; it < 4000; it++) {
    const n = 1 + Math.floor(rnd() * 7);
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(VOCAB[Math.floor(rnd() * VOCAB.length)]!);
    const src = lines.join("\n");
    const a = voidCounts(src);
    const b = countVoidish(blocksFromBody(src));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      if (mism < 15) console.log("MISMATCH:", JSON.stringify(src), "scan=", JSON.stringify(a), "save=", JSON.stringify(b));
      mism++;
    }
  }
  console.log("total mismatches:", mism, "/4000");
});
