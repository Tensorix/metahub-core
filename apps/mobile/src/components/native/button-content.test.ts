import { expect, test } from "bun:test";
import { createElement } from "react";
import { nativeButtonContent } from "./button-content";

test("raw button text uses the native label path on both platforms", () => {
  expect(nativeButtonContent(undefined, "取消")).toEqual({ label: "取消" });
  expect(nativeButtonContent("fallback", "保存中…")).toEqual({ label: "保存中…" });
  expect(nativeButtonContent(undefined, 0)).toEqual({ label: "0" });
});

test("explicit labels and structured native children remain intact", () => {
  const nativeView = createElement("NativeText", null, "保存");
  expect(nativeButtonContent("继续", undefined)).toEqual({ label: "继续" });
  expect(nativeButtonContent(undefined, nativeView).children).toBe(nativeView);
});


test("split text children are combined and false children do not hide the explicit label", () => {
  expect(nativeButtonContent(undefined, ["已选 ", 3, " 项"])).toEqual({ label: "已选 3 项" });
  expect(nativeButtonContent("继续", false)).toEqual({ label: "继续" });
  expect(nativeButtonContent("继续", [])).toEqual({ label: "继续" });
});
