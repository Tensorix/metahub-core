import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";
import { assertTableImageSize, copyTableImage } from "./table-image";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

test("registers the PNG clipboard item during the click, before table data resolves", async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const item = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
  let offered: Promise<Blob> | undefined;
  let rejectSource!: (reason: Error) => void;
  let writes = 0;
  try {
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: class {
      constructor(flavors: Record<string, Promise<Blob>>) { offered = flavors["image/png"]; }
    } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      async write() { writes++; await offered; },
    } });
    const done = copyTableImage(() => new Promise((_, reject) => { rejectSource = reject; }));
    expect(writes).toBe(1);
    expect(offered).toBeInstanceOf(Promise);
    rejectSource(new Error("View changed"));
    await done;
    await expect(offered!).rejects.toThrow("View changed");
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (item) Object.defineProperty(globalThis, "ClipboardItem", item);
    else Reflect.deleteProperty(globalThis, "ClipboardItem");
  }
});

test("preflights excessively tall, wide and high-area exports before fetching their rows", () => {
  expect(() => assertTableImageSize(100, 6)).not.toThrow();
  expect(() => assertTableImageSize(50_000, 1)).toThrow();
  expect(() => assertTableImageSize(1, 2_000)).toThrow();
  expect(() => assertTableImageSize(400, 100)).toThrow();
});
