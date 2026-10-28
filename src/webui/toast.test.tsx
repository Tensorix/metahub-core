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
  await act(async () => { handles = [1, 2, 3].map(i => toast(`Toast ${i}`, { action: { label: "Undo", run: () => { calls++; } } })); });
  const cards = host.querySelectorAll<HTMLElement>(".toast");
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
