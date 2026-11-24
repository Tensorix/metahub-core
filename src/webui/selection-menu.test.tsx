/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { closeMenu, MenuItem, openMenu, UiHost } from "./ui.tsx";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

let host: HTMLDivElement;
let trigger: HTMLButtonElement;
beforeEach(async () => {
  host = document.createElement("div");
  trigger = document.createElement("button");
  trigger.setAttribute("aria-expanded", "false");
  document.body.append(host, trigger);
  await act(async () => render(<UiHost />, host));
});
afterEach(async () => {
  await act(async () => { closeMenu(); render(null, host); });
  document.body.classList.remove("mobile-database");
  host.remove();
  trigger.remove();
});

async function openActions() {
  await act(async () => openMenu(trigger, close => <MenuItem label="Copy as image" onClick={close} />, {
    placement: "above", label: "Selection actions",
  }));
  return host.querySelector<HTMLElement>('[role="dialog"][aria-label="Selection actions"]')!;
}

test("selection menu anchors above, clamps to the viewport, and flips below a high trigger", async () => {
  trigger.getBoundingClientRect = () => new DOMRect(-10, 300, 32, 32);
  const menu = await openActions();
  menu.getBoundingClientRect = () => new DOMRect(0, 0, 180, 84);
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(menu.style.top).toBe("210px");
  expect(menu.style.left).toBe("8px");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(menu.querySelector("button"));

  trigger.getBoundingClientRect = () => new DOMRect(innerWidth - 50, 20, 32, 32);
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(menu.style.top).toBe("58px");
  expect(menu.style.left).toBe((innerWidth - 188) + "px");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
  expect(host.querySelector(".pop")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("touch actions open a named sheet and return focus to their trigger", async () => {
  document.body.classList.add("mobile-database");
  const menu = await openActions();
  expect(menu.getAttribute("aria-modal")).toBe("true");
  expect(menu.classList.contains("sheet")).toBe(true);
  expect(trigger.inert).toBe(true);
  await act(async () => menu.querySelector("button")!.click());
  expect(trigger.inert).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
