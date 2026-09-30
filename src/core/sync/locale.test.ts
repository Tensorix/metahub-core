import { test, expect } from "bun:test";
import { localeFromAcceptLanguage, localeFromCookie, localeFromTags, pickLocale } from "./locale.ts";

test("negotiation takes the first supported tag, defaults to zh-CN without a signal", () => {
  expect(localeFromTags(["zh-CN", "en"])).toBe("zh-CN");
  expect(localeFromTags(["en-US", "zh"])).toBe("en");
  expect(localeFromTags(["ja"])).toBe("en");
  expect(localeFromTags([])).toBe("zh-CN");
  expect(localeFromAcceptLanguage("en-US,en;q=0.9,zh;q=0.8")).toBe("en");
  expect(localeFromAcceptLanguage(null)).toBe("zh-CN");
});

test("the mh-lang cookie wins over Accept-Language", () => {
  expect(localeFromCookie("mh_token=x; mh-lang=en")).toBe("en");
  expect(localeFromCookie("mh-lang=fr")).toBeNull();
  expect(localeFromCookie(null)).toBeNull();
  const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  expect(pickLocale(req({ "accept-language": "en" }))).toBe("en");
  expect(pickLocale(req({ "accept-language": "en", cookie: "mh-lang=zh-CN" }))).toBe("zh-CN");
  expect(pickLocale(req({}))).toBe("zh-CN");
});
