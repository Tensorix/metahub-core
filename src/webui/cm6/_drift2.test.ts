import { test } from "bun:test";
import { scanDoc } from "./blockmodel";
import { blocksFromBody, serializeBlocks } from "../blocks";

function show(src: string) {
  const editorVoids = scanDoc(src).voids.map((v) => v.block.type);
  const saved = blocksFromBody(src);
  const savedTop = saved.map((b) => b.type);
  console.log("SRC:", JSON.stringify(src));
  console.log("  editor voids:", JSON.stringify(editorVoids));
  console.log("  save blocks :", JSON.stringify(savedTop));
  try { console.log("  reserialize:", JSON.stringify(serializeBlocks(saved))); } catch {}
}

test("media after paragraph drift", () => {
  show("para\n![img](/blob/x.png)");
  show("para\n[d.pdf](/blob/d.pdf \"7\")");
  show("intro\n![img](/blob/x.png)\nmore");
  show("![a](/blob/a.png)\n![b](/blob/b.png)"); // two images, no prose
  show("para\n\n![img](/blob/x.png)"); // WITH blank line between
});
