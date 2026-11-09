import { expect, test } from "bun:test";
import { isFullSwipe } from "./full-swipe";

test("only a long leftward swipe commits; short, rightward and vertical gestures do not", () => {
  expect(isFullSwipe(-260, 8, 400)).toBe(true);
  expect(isFullSwipe(-259, 8, 400)).toBe(false);
  expect(isFullSwipe(-80, 0, 400)).toBe(false);
  expect(isFullSwipe(300, 0, 400)).toBe(false);
  expect(isFullSwipe(-300, 200, 400)).toBe(false);
  expect(isFullSwipe(-300, 0, 0)).toBe(false);
  expect(isFullSwipe(-400, 0, 800)).toBe(false);
  expect(isFullSwipe(-520, 0, 800)).toBe(true);
});
