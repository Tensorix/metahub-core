import { test, expect, afterEach } from "bun:test";
import { fmtDate, fmtRelative, weekdayLabels } from "./fmt.ts";
import { setLocaleOverride } from "./locale.ts";

afterEach(() => setLocaleOverride(null));

const d = new Date(2026, 6, 10, 14, 2);

test("zh-CN date styles", () => {
  expect(fmtDate(d, "longDate")).toBe("2026年7月10日");
  expect(fmtDate(d, "monthDay")).toBe("7月10日");
  expect(fmtDate(d, "yearMonth")).toBe("2026年7月");
  expect(fmtDate(d, "month")).toBe("7月");
  expect(fmtDate(d, "time")).toBe("14:02");
  expect(fmtDate(d, "monthDayTime")).toBe("7月10日 14:02");
  expect(weekdayLabels()).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
});

test("en date styles", () => {
  setLocaleOverride("en");
  expect(fmtDate(d, "longDate")).toBe("July 10, 2026");
  expect(fmtDate(d, "monthDay")).toBe("Jul 10");
  expect(fmtDate(d, "yearMonth")).toBe("July 2026");
  expect(fmtDate(d, "month")).toBe("Jul");
  expect(fmtDate(d, "time")).toBe("2:02 PM");
  expect(weekdayLabels()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
});

test("fmtRelative buckets in both locales", () => {
  const now = Date.now();
  expect(fmtRelative(now - 5_000, now)).toBe("刚刚");
  expect(fmtRelative(now - 3 * 3_600_000, now)).toBe("3 小时前");
  setLocaleOverride("en");
  expect(fmtRelative(now - 5_000, now)).toBe("just now");
  expect(fmtRelative(now - 90_000, now)).toBe("1 minute ago");
  expect(fmtRelative(now - 2 * 86_400_000, now)).toBe("2 days ago");
});
