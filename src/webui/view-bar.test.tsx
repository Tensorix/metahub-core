/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { ViewToolbar } from "./view-bar.tsx";
import { emptyView, searchRecords } from "./view-model.ts";
import { IS_MAC } from "./shortcuts.ts";
import type { Prop, Rec } from "./api.ts";

GlobalRegistrator.register();
let host: HTMLDivElement;
const props = [{ id: "title", name: "Title", type: "text" }] as Prop[];
const records: Rec[] = ["Alpha", "Beta"].map((title, i) => ({
  id: String(i + 1), database_id: "db", cells: { title }, values: { Title: title },
}));

function Harness() {
  const [query, setQuery] = useState("");
  return <>
    <ViewToolbar props={props} view={emptyView("table", "Table")}
      onChange={() => {}} onReorder={() => {}} pickRefs={() => {}}
      query={query} onQuery={setQuery} />
    <output>{searchRecords(records, props, query).map((r) => r.id).join(",")}</output>
  </>;
}

function findKey(target: EventTarget = window, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "f", bubbles: true, cancelable: true,
    ...(IS_MAC ? { metaKey: true } : { ctrlKey: true }), ...extra,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  act(() => render(<Harness />, host));
});
afterEach(() => {
  act(() => render(null, host));
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());

test("find opens the table search, filters records, and Escape restores them", () => {
  expect(host.querySelector("input")).toBeNull();
  let event!: KeyboardEvent;
  act(() => { event = findKey(); });
  expect(event.defaultPrevented).toBe(true);
  const input = host.querySelector<HTMLInputElement>(".tb-search input")!;
  expect(document.activeElement).toBe(input);
  act(() => {
    input.value = "beta";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector("output")!.textContent).toBe("2");
  act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector("output")!.textContent).toBe("1,2");
});

test("find refocuses and selects an existing query", () => {
  act(() => { findKey(); });
  const input = host.querySelector<HTMLInputElement>("input")!;
  act(() => {
    input.value = "alpha";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.blur();
  act(() => { findKey(); });
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
  expect(input.value).toBe("alpha");
});

test("find respects handled events, IME, other modifiers, and modal ownership", () => {
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { shiftKey: true }]) {
    expect(findKey(window, extra).defaultPrevented).toBe(false);
  }
  const consume = (event: Event) => event.preventDefault();
  host.addEventListener("keydown", consume);
  act(() => { findKey(host); });
  host.removeEventListener("keydown", consume);
  expect(host.querySelector("input")).toBeNull();
  for (const cls of ["modal-scrim open", "lightbox"]) {
    const overlay = document.createElement("div");
    overlay.className = cls;
    host.append(overlay);
    act(() => { expect(findKey().defaultPrevented).toBe(false); });
    overlay.remove();
  }
  expect(host.querySelector("input")).toBeNull();
});

test("unmount removes the table find shortcut", () => {
  act(() => render(null, host));
  expect(findKey().defaultPrevented).toBe(false);
});
