import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import { csvTable, shareToolsHtml, shareToolsScript } from "./share-tools.ts";
import { copySourceHtml } from "./share-copy.ts";
import { shareCellHtml, shareTableHtml } from "./share-table.ts";
import { escapeHtml } from "./html-escape.ts";

GlobalRegistrator.register();
afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); });
afterAll(() => GlobalRegistrator.unregister());

function fixture(kind: "doc" | "database", body: string, title = "会议记录") {
  document.body.innerHTML = `<div class="wrap" data-share-kind="${kind}">${shareToolsHtml(kind, title, "en")}${body}</div>`;
  window.eval(shareToolsScript("en"));
}

async function captureDownload(run: () => void) {
  let blob: Blob | undefined, filename = "";
  const create = window.URL.createObjectURL, click = window.HTMLAnchorElement.prototype.click;
  window.URL.createObjectURL = (value) => { blob = value as Blob; return "blob:test-export"; };
  window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  try { run(); } finally { window.URL.createObjectURL = create; window.HTMLAnchorElement.prototype.click = click; }
  return { filename, type: blob?.type, text: blob ? await blob.text() : undefined };
}

test("CSV retains quotes, commas, newlines, whitespace and empty cells", () => {
  expect(csvTable(["名称", "备注"], [['a,"b"', "第一行\n第二行"], [" x ", ""]]))
    .toBe('"名称","备注"\r\n"a,""b""","第一行\n第二行"\r\n" x ",""\r\n');
  expect(csvTable(["名称"], [])).toBe('"名称"\r\n');
});

test("Markdown download preserves the original source, not rendered HTML", async () => {
  const md = '# 会议\n\n**重点** & <script>literal</script>\n\n| A | B |\n|---|---|\n';
  fixture("doc", `<article class="doc"><h1>会议</h1></article>${copySourceHtml(md)}`, '会议/<草稿>');
  const result = await captureDownload(() => document.querySelector<HTMLButtonElement>("#mh-download")!.click());
  expect(result).toEqual({ filename: "会议__草稿_.md", type: "text/markdown;charset=utf-8", text: md });
  expect(document.querySelector(".share-tool-feedback")!.textContent).toBe("Download started");
  expect(document.querySelector('a[download]')).toBeNull();
});

test("CSV download reads complete current cells and tag labels, without disclosure buttons", async () => {
  const full = '第一行,"quoted"\n' + "长文本".repeat(200);
  fixture("database", shareTableHtml([{ name: "备注" }, { name: "标签" }],
    `<tr>${shareCellHtml(escapeHtml(full), "备注", "en")}${shareCellHtml('<span class="tag">甲</span><span class="tag">乙</span>', "标签", "en")}</tr>`, "en"));
  document.querySelector(".share-cell-value")!.textContent = full + "已更新";
  const result = await captureDownload(() => document.querySelector<HTMLButtonElement>("#mh-download")!.click());
  expect(result.filename).toBe("会议记录.csv");
  expect(result.type).toBe("text/csv;charset=utf-8");
  // Blob.text preserves the UTF-8 BOM, which helps spreadsheet apps detect Chinese.
  expect(result.text).toBe("\uFEFF" + csvTable(["备注", "标签"], [[full + "已更新", "甲, 乙"]]));
});

test("download waits for pending saves and unsaved document editing", async () => {
  for (const body of ['<div class="saving"></div>', '<textarea class="mh-raw"></textarea>']) {
    fixture("doc", body + copySourceHtml("saved source"));
    const result = await captureDownload(() => document.querySelector<HTMLButtonElement>("#mh-download")!.click());
    expect(result.text).toBeUndefined();
    expect(document.querySelector(".share-tool-feedback")!.textContent).toBe("Save your changes before downloading");
  }
});

test("width toggle persists separately by content type and restores its accessible state", () => {
  fixture("doc", "");
  document.querySelector<HTMLButtonElement>("#mh-width")!.click();
  expect(localStorage.getItem("mh-share-width-doc")).toBe("wide");
  expect(document.querySelector("#mh-width")!.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector("#mh-width")!.getAttribute("aria-label")).toBe("Standard view");
  fixture("database", "");
  expect(document.querySelector("[data-share-kind]")!.getAttribute("data-share-wide")).toBe("false");
  fixture("doc", "");
  expect(document.querySelector("[data-share-kind]")!.getAttribute("data-share-wide")).toBe("true");
  document.querySelector<HTMLButtonElement>("#mh-width")!.click();
  expect(localStorage.getItem("mh-share-width-doc")).toBe("standard");
});
