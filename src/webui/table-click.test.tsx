/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { api, type Db, type Prop, type Rec } from "./api.ts";
import { DatabaseView } from "./table.tsx";

GlobalRegistrator.register();
const original = { listProperties: api.listProperties, listRecords: api.listRecords, listLocalShares: api.listLocalShares };
const db: Db = { id: "db-click", name: "Clicks", icon: null, meta: null, created_hlc: "" };
const props: Prop[] = [{ id: "title", database_id: db.id, name: "Title", type: "text", config: null, position: 0 }];
const records: Rec[] = ["Alpha", "Beta"].map((title, i) => ({
  id: `rec-${i}`, database_id: db.id, cells: { title }, values: { Title: title },
}));
let host: HTMLDivElement;
const cell = (r: number) => host.querySelector<HTMLElement>(`td.cell-td[data-r="${r}"][data-c="0"]`)!;
const editor = () => document.querySelector(".celledit");
const pointer = (target: EventTarget, type: string, extra: PointerEventInit = {}) => {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10, clientY: 10, ...extra }));
};
function clickCell(r: number, shiftKey = false) {
  act(() => { pointer(cell(r), "pointerdown", { shiftKey }); });
  act(() => { pointer(window, "pointerup", { shiftKey }); });
  act(() => { cell(r).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey })); });
}

beforeEach(async () => {
  api.listProperties = async () => props;
  api.listRecords = async () => records;
  api.listLocalShares = async () => [];
  localStorage.removeItem(`mh.db.view.${db.id}`);
  host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    render(<DatabaseView db={db} rec={null} onRecNav={() => {}} tabReq={null} onTabReq={() => {}}
      onError={(message) => { throw new Error(message); }} />, host);
  });
});
afterEach(() => {
  act(() => render(null, host));
  host.remove();
  Object.assign(api, original);
});
afterAll(() => GlobalRegistrator.unregister());

test("first click selects, a later click on the selected cell opens its editor", () => {
  clickCell(0);
  expect(cell(0).classList.contains("cellsel")).toBe(true);
  expect(editor()).toBeNull();
  clickCell(0);
  expect(editor()).not.toBeNull();
  expect(document.activeElement?.closest(".celledit")).not.toBeNull();
});

test("clicking a different cell selects it without editing", () => {
  clickCell(0);
  clickCell(1);
  expect(cell(0).classList.contains("cellsel")).toBe(false);
  expect(cell(1).classList.contains("cellsel")).toBe(true);
  expect(editor()).toBeNull();
  clickCell(1);
  expect(editor()).not.toBeNull();
});

test("Shift extends the range and clicking inside it first collapses the selection", () => {
  clickCell(0);
  clickCell(1, true);
  expect(host.querySelectorAll("td.cellsel").length).toBe(2);
  expect(editor()).toBeNull();
  clickCell(1);
  expect(host.querySelectorAll("td.cellsel").length).toBe(1);
  expect(editor()).toBeNull();
  clickCell(1, true);
  expect(editor()).toBeNull();
});

test("dragging or cancelling over a selected cell never opens its editor", () => {
  clickCell(0);
  act(() => { pointer(cell(0), "pointerdown"); });
  act(() => { pointer(window, "pointercancel"); });
  act(() => { cell(0).click(); });
  expect(editor()).toBeNull();
  act(() => { pointer(cell(0), "pointerdown"); });
  const originalHit = document.elementFromPoint;
  document.elementFromPoint = () => cell(1);
  try {
    act(() => { pointer(window, "pointermove", { clientY: 20 }); });
    act(() => { pointer(window, "pointerup", { clientY: 20 }); });
    act(() => { cell(0).click(); });
  } finally { document.elementFromPoint = originalHit; }
  expect(host.querySelectorAll("td.cellsel").length).toBe(2);
  expect(editor()).toBeNull();
});
