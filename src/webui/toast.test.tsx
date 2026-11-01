/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { UiHost, toast } from "./ui.tsx";
GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
test("dismiss removes only its own notification; undo runs once", async () => {
  const host = document.createElement("div"); document.body.append(host);
  let calls = 0;
  await act(async () => render(<UiHost />, host));
  let handles: { dismiss: () => void }[] = [];
  const messages = [1, 2, 3].map(i => `[toast-dismiss-test] Toast ${i}`);
  await act(async () => { handles = messages.map(msg => toast(msg, { action: { label: "Undo", run: () => { calls++; } } })); });
  // Other DOM tests share the imperative store; inspect only this test's toasts.
  const cards = Array.from(host.querySelectorAll<HTMLElement>(".toast"))
    .filter(card => messages.includes(card.querySelector(".toast-msg")?.textContent ?? ""));
  expect(cards.length).toBe(3);
  await act(async () => handles[1]!.dismiss());
  expect(calls).toBe(0);
  expect(cards[1]!.classList.contains("leaving")).toBe(true);
  expect(cards[0]!.classList.contains("leaving")).toBe(false);
  const undo = cards[0]!.querySelector<HTMLButtonElement>(".toast-act")!;
  await act(async () => { undo.click(); undo.click(); });
  expect(calls).toBe(1);
  await act(async () => handles.forEach(h => h.dismiss()));
  await new Promise(resolve => setTimeout(resolve, 180));
  act(() => render(null, host)); host.remove();
});
