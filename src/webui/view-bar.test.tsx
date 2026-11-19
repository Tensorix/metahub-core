/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { closeMenu } from "./ui";
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

function Harness({ bottom = false }: { bottom?: boolean }) {
  const [query, setQuery] = useState("");
  return <>
    <ViewToolbar bottom={bottom} props={props} view={emptyView("table", "Table")}
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


test("mobile bottom tools keep search reachable while filtering and closing restores records", () => {
  act(() => render(<Harness bottom />, host));
  const search = host.querySelector<HTMLButtonElement>('.mobile-db-tools button[aria-expanded]')!;
  expect(search.textContent).toContain("搜索");
  act(() => search.click());
  const input = host.querySelector<HTMLInputElement>('.mobile-db-tools input')!;
  expect(document.activeElement).toBe(input);
  expect(search.getAttribute('aria-expanded')).toBe('true');
  act(() => {
    input.value = 'beta';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelector('output')!.textContent).toBe('2');
  expect(host.querySelectorAll('.mobile-db-tools .toolbar > button').length).toBe(4);
  act(() => host.querySelector<HTMLButtonElement>('.tb-search .clear')!.click());
  expect(host.querySelector('input')).toBeNull();
  expect(search.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('output')!.textContent).toBe('1,2');
});

test("native toolbar commands validate fields and filter records without a web input", () => {
  const changes: unknown[] = [];
  const queries: string[] = [];
  const view = emptyView("table", "Table");
  act(() => render(
    <ViewToolbar bottom props={props} view={view}
      onChange={patch => changes.push(patch)} onReorder={() => {}} pickRefs={() => {}}
      query="" onQuery={q => queries.push(q)} showToolbar={async () => {}} />, host));
  const send = (action: string, propertyId?: string) => act(() => {
    document.dispatchEvent(new CustomEvent("database-toolbar-action", { detail: { action, propertyId } }));
  });
  send("filter", "deleted-property");
  expect(changes).toEqual([]);
  send("filter", "title");
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ filter: { rules: [{ prop: "title" }] } });
  closeMenu();
  const search = (operation: string, query = "", viewId = view.id) => act(() => {
    document.dispatchEvent(new CustomEvent("database-toolbar-action", { detail: { action: "search", operation, query, viewId } }));
  });
  search("open");
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector('[data-action="search"]')?.getAttribute("aria-expanded")).toBe("true");
  search("change", "alpha");
  search("change", "ignored", "another-view");
  search("close");
  search("change", "after-close");
  expect(queries).toEqual(["alpha", ""]);
  expect(host.querySelector('[data-action="search"]')?.getAttribute("aria-expanded")).toBe("false");
});

test("native sort and column menus update the active view and protect its title", () => {
  const fields = [...props, { ...props[0]!, id: "stage", name: "Stage" }];
  const initial = emptyView("table", "Table");
  let current = initial;
  const moves: unknown[] = [];
  function SettingsHarness() {
    const [view, setView] = useState(initial);
    current = view;
    return <ViewToolbar bottom props={fields} view={view}
      onChange={patch => setView(prev => ({ ...prev, ...patch }))} onReorder={(...args) => moves.push(args)}
      pickRefs={() => {}} query="" onQuery={() => {}} showToolbar={async () => {}} />;
  }
  act(() => render(<SettingsHarness />, host));
  const send = (command: Record<string, unknown>) => act(() => {
    document.dispatchEvent(new CustomEvent("database-toolbar-action", { detail: { viewId: initial.id, ...command } }));
  });
  send({ action: "sort", operation: "set", propertyId: "stage", desc: false });
  send({ action: "sort", operation: "set", propertyId: "title", desc: true });
  send({ action: "sort", operation: "move", propertyId: "title", targetId: "stage", where: "before" });
  expect(current.sort).toEqual([{ prop: "title", desc: true }, { prop: "stage", desc: false }]);
  send({ action: "sort", operation: "set", propertyId: "stage", desc: true });
  send({ action: "sort", operation: "remove", propertyId: "title" });
  send({ action: "sort", operation: "clear", viewId: "stale" });
  expect(current.sort).toEqual([{ prop: "stage", desc: true }]);
  send({ action: "sort", operation: "clear" });
  expect(current.sort).toEqual([]);
  send({ action: "properties", operation: "visible", propertyId: "title", visible: false });
  expect(current.hidden).toEqual([]);
  send({ action: "properties", operation: "all", visible: false });
  expect(current.hidden).toEqual(["stage"]);
  send({ action: "properties", operation: "move", propertyId: "stage", targetId: "title", where: "before" });
  expect(moves).toEqual([["stage", "title", "before"]]);
  expect(current.hidden).toEqual([]);
  send({ action: "properties", operation: "visible", propertyId: "stage", visible: false });
  expect(current.hidden).toEqual(["stage"]);
  send({ action: "properties", operation: "all", visible: true });
  expect(current.hidden).toEqual([]);
});
