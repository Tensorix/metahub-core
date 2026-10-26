import { expect, test } from "bun:test";
import {
  IOS_SHEET_PADDING,
  iosSheetContentHeight,
} from "./sheet-content-layout";

const phone = {
  windowHeight: 874,
  windowWidth: 402,
  screenHeight: 874,
  preferredHeight: 600,
  safeTop: 62,
  safeBottom: 34,
};
test("keyboard constrains the measured RN sheet including native padding and safe area", () => {
  const keyboard = { screenY: 548, width: 402, height: 326 };
  const height = iosSheetContentHeight({ ...phone, keyboard });
  expect(height).toBe(388);
  expect(
    height +
      IOS_SHEET_PADDING.top +
      IOS_SHEET_PADDING.bottom +
      phone.safeTop +
      phone.safeBottom,
  ).toBeLessThan(keyboard.screenY);
  expect(iosSheetContentHeight(phone)).toBe(600);
});
test("already-resized windows do not subtract the keyboard twice", () => {
  const keyboard = { screenY: 548, width: 402, height: 326 };
  expect(iosSheetContentHeight({ ...phone, windowHeight: 548, keyboard })).toBe(
    388,
  );
});
test("rotation and very short keyboard viewports never force an overflowing minimum", () => {
  const height = iosSheetContentHeight({
    windowHeight: 402,
    windowWidth: 874,
    screenHeight: 402,
    preferredHeight: 281,
    safeTop: 0,
    safeBottom: 21,
    keyboard: { screenY: 169, width: 874, height: 233 },
  });
  expect(height).toBe(84);
  expect(
    iosSheetContentHeight({
      ...phone,
      keyboard: { screenY: 40, width: 402, height: 834 },
    }),
  ).toBe(0);
});
test("floating and hidden keyboard frames do not reserve an entire bottom region", () => {
  expect(
    iosSheetContentHeight({
      ...phone,
      keyboard: { screenY: 420, width: 300, height: 200 },
    }),
  ).toBe(600);
  expect(
    iosSheetContentHeight({
      ...phone,
      keyboard: { screenY: 874, width: 402, height: 0 },
    }),
  ).toBe(600);
});
test("short windows cap preferred content even before the keyboard opens", () => {
  expect(
    iosSheetContentHeight({
      ...phone,
      windowHeight: 500,
      preferredHeight: 600,
    }),
  ).toBe(340);
});
