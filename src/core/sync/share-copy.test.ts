import { test, expect } from "bun:test";
import { markdownTable, copyButtonHtml, copySourceHtml, copyScript } from "./share-copy.ts";

test("markdownTable: header, delimiter, rows; pipes escaped, newlines flattened", () => {
  const md = markdownTable(["名称", "备注"], [["a|b", "第一行\n第二行"], ["", "x"]]);
  expect(md.split("\n")).toEqual(["| 名称 | 备注 |", "| --- | --- |", "| a\\|b | 第一行 第二行 |", "|  | x |"]);
});

test("copy button carries both icons, label, and an accessible name", () => {
  const html = copyButtonHtml();
  expect(html).toContain('id="mh-copy"');
  expect(html).toContain('aria-label="复制全文"');
  expect(html).toContain('class="ic-copy"');
  expect(html).toContain('class="ic-check"');
});

test("copy source is an inert template with escaped content", () => {
  const html = copySourceHtml("<script>alert(1)</script> & `x`");
  expect(html).toBe('<template id="mh-src">&lt;script&gt;alert(1)&lt;/script&gt; &amp; `x`</template>');
  expect(copyScript()).toContain("ClipboardItem");
  expect(copyScript()).toContain("execCommand('copy')");
});
