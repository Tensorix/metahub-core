import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
import { afterAll, afterEach, expect, test } from "bun:test";
import { mountShareTable, shareCellHtml, shareTableHtml, shareTableScript } from "./share-table.ts";
import { escapeHtml } from "./html-escape.ts";
import { copyScript, copySourceHtml } from "./share-copy.ts";

afterEach(() => { document.body.innerHTML = ""; });
afterAll(() => GlobalRegistrator.unregister());

const full = '第一段\n\n<script>literal text</script>\n' + "连续内容".repeat(1000);
function fixture() {
  document.body.innerHTML = shareTableHtml([{ name: "编号" }, { name: "原始资料" }],
    `<tr>${shareCellHtml("TAG-004", "编号", "zh-CN")}${shareCellHtml(escapeHtml(full), "原始资料", "zh-CN")}</tr>`, "zh-CN");
  const values = Array.from(document.querySelectorAll<HTMLElement>(".share-cell-value"));
  for (const [i, value] of values.entries()) {
    Object.defineProperties(value, { clientHeight: { value: 65 }, scrollHeight: { value: i ? 4000 : 22, configurable: true }, clientWidth: { value: 160 }, scrollWidth: { value: 160 } });
  }
  // Layout comes from browser verification; here exercise disclosure with known
  // overflow measurements, including text that must never become markup.
  return values;
}
const labels = { copied: "Copied", failed: "Failed", record: "Record" };

test("table labels are escaped, widths are bounded, and full values survive rendering", () => {
  const html = shareTableHtml([{ name: '<img onerror="bad()">', width: Infinity }, { name: "x", width: 10000 }],
    `<tr>${shareCellHtml(escapeHtml(full), '" field', "en")}</tr>`, "en");
  expect(html).not.toContain('<img onerror="bad()">');
  expect(html).toContain("width:820px");
  expect(html).toContain("Read full &quot; field");
  document.body.innerHTML = html;
  expect(document.querySelector(".share-cell-value")!.textContent).toBe(full);
  expect(document.querySelector("script")).toBeNull();
});

test("only clipped cells expose an expand action; drawer keeps full text and record context", () => {
  fixture();
  mountShareTable(labels);
  const buttons = document.querySelectorAll<HTMLButtonElement>(".share-cell-expand");
  expect(buttons[0]!.hidden).toBe(true);
  expect(buttons[1]!.hidden).toBe(false);
  buttons[1]!.click();
  const peek = document.querySelector<HTMLDialogElement>("dialog")!;
  expect(peek.open).toBe(true);
  expect(document.querySelector(".share-text-body")!.textContent).toBe(full);
  expect(document.querySelector("#share-text-heading")!.textContent).toBe("原始资料");
  expect(document.querySelector(".share-text-record")!.textContent).toBe("TAG-004");
  expect(buttons[1]!.closest("td")!.classList.contains("is-selected")).toBe(true);
  document.querySelector<HTMLButtonElement>(".share-text-close")!.click();
  expect(peek.open).toBe(false);
});

test("server-serialized script initializes and copy reads the complete current cell", async () => {
  fixture();
  // This is the actual SSR delivery path, not just a direct function call.
  window.eval(shareTableScript("en"));
  document.querySelectorAll<HTMLButtonElement>(".share-cell-expand")[1]!.click();
  let copied = "";
  const original = navigator.clipboard.writeText;
  navigator.clipboard.writeText = async (value) => { copied = value; };
  try {
    document.querySelector<HTMLButtonElement>(".share-text-copy")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copied).toBe(full);
    expect(document.querySelector(".share-text-feedback")!.textContent).toBe("Copied");
  } finally { navigator.clipboard.writeText = original; }
});

test("copying the table includes full values and excludes preview controls", async () => {
  fixture();
  mountShareTable(labels);
  document.body.insertAdjacentHTML("beforeend", `<button id="mh-copy"><span>Copy</span></button>${copySourceHtml(full)}`);
  let items: ClipboardItem[] = [];
  const original = navigator.clipboard.write;
  navigator.clipboard.write = async (value) => { items = [...value]; };
  try {
    window.eval(copyScript("en"));
    document.querySelector<HTMLButtonElement>("#mh-copy")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await items[0]!.getType("text/plain")).text()).toBe(full);
    const html = await (await items[0]!.getType("text/html")).text();
    expect(html).not.toContain("share-cell-expand");
    expect(html).not.toContain("data-ready");
    expect(html).toContain(escapeHtml(full));
  } finally { navigator.clipboard.write = original; }
});
