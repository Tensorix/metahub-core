import { describe, expect, test } from "bun:test";
import {
  AUTO_TITLE_MAX,
  autoTitleFor,
  dateTitleFromHlc,
  deriveAutoTitle,
  isAutoTitleState,
} from "./auto-title.ts";

const hlcAt = (d: Date) => `${String(d.getTime()).padStart(15, "0")}-0001-node`;

describe("deriveAutoTitle", () => {
  test("plain first line", () => {
    expect(deriveAutoTitle("买牛奶\n明天去超市")).toBe("买牛奶");
  });

  test("leading blank lines and CRLF", () => {
    expect(deriveAutoTitle("\r\n\r\nhello\r\nworld")).toBe("hello");
  });

  test("heading marker stripped", () => {
    expect(deriveAutoTitle("# 周报\n内容")).toBe("周报");
    expect(deriveAutoTitle("### deep heading")).toBe("deep heading");
  });

  test("list / todo / quote markers stripped, nesting peeled", () => {
    expect(deriveAutoTitle("- item one")).toBe("item one");
    expect(deriveAutoTitle("- [ ] buy milk")).toBe("buy milk");
    expect(deriveAutoTitle("- [x] done thing")).toBe("done thing");
    expect(deriveAutoTitle("1. first")).toBe("first");
    expect(deriveAutoTitle("> a quote")).toBe("a quote");
    expect(deriveAutoTitle("> - **nested**")).toBe("nested");
  });

  test("inline marks flattened", () => {
    expect(deriveAutoTitle("**bold** and `code` and [text](https://x)")).toBe("bold and code and text");
  });

  test("standalone media line skipped, text after it wins", () => {
    expect(deriveAutoTitle("![shot](/blob/a.png)\n会议记录")).toBe("会议记录");
    expect(deriveAutoTitle("![](/blob/a.png?w=300)\n下一行")).toBe("下一行");
  });

  test("all-media body yields null", () => {
    expect(deriveAutoTitle("![a](/blob/a.png)\n![b](/blob/b.png)")).toBeNull();
  });

  test("divider skipped, next line wins", () => {
    expect(deriveAutoTitle("---\n正文开始")).toBe("正文开始");
    expect(deriveAutoTitle("---\n***\n___")).toBeNull();
  });

  test("code fence opening aborts entirely", () => {
    expect(deriveAutoTitle("```js\nconst x = 1\n```\n后面的文字")).toBeNull();
    expect(deriveAutoTitle("~~~\nraw\n~~~")).toBeNull();
  });

  test("table row aborts entirely", () => {
    expect(deriveAutoTitle("| a | b |\n| --- | --- |\n文字")).toBeNull();
  });

  test("bare doclink dropped, alias kept, mixed line normalized", () => {
    expect(deriveAutoTitle("[[doc_abc123]]")).toBeNull(); // whole line is a bare ref
    expect(deriveAutoTitle("[[doc_abc123|设计稿]]")).toBe("设计稿");
    expect(deriveAutoTitle("见 [[doc_abc123]] 的说明")).toBe("见 的说明");
  });

  test("pure emoji line kept", () => {
    expect(deriveAutoTitle("🎉🎉")).toBe("🎉🎉");
  });

  test("truncates at 64 code points without splitting surrogate pairs", () => {
    const t = deriveAutoTitle("a".repeat(63) + "😀😀tail")!;
    expect(Array.from(t).length).toBe(AUTO_TITLE_MAX);
    expect(t.endsWith("😀")).toBe(true); // 64th code point is the intact emoji
    const emoji = deriveAutoTitle("😀".repeat(70))!;
    expect(emoji).toBe("😀".repeat(64));
  });

  test("gives up after scanning five non-blank unusable lines", () => {
    const body = Array(5).fill("![x](/blob/x.png)").join("\n") + "\n真正的文字";
    expect(deriveAutoTitle(body)).toBeNull();
  });

  test("empty body", () => {
    expect(deriveAutoTitle("")).toBeNull();
    expect(deriveAutoTitle("\n\n  \n")).toBeNull();
  });
});

describe("dateTitleFromHlc", () => {
  test("formats local date without zero padding", () => {
    expect(dateTitleFromHlc(hlcAt(new Date(2026, 7, 9, 12)))).toBe("2026年8月9日");
    expect(dateTitleFromHlc(hlcAt(new Date(2025, 11, 31, 23)))).toBe("2025年12月31日");
  });

  test("garbage / missing hlc falls back to now", () => {
    const now = new Date(2026, 0, 2, 3);
    expect(dateTitleFromHlc("garbage", now)).toBe("2026年1月2日");
    expect(dateTitleFromHlc("", now)).toBe("2026年1月2日");
    expect(dateTitleFromHlc(null, now)).toBe("2026年1月2日");
  });
});

describe("autoTitleFor", () => {
  const hlc = hlcAt(new Date(2026, 7, 28, 10));

  test("blank body maps to empty title", () => {
    expect(autoTitleFor("", hlc)).toBe("");
    expect(autoTitleFor("  \n\n", hlc)).toBe("");
  });

  test("derivable body uses the derived title", () => {
    expect(autoTitleFor("买牛奶\n明天", hlc)).toBe("买牛奶");
  });

  test("underivable body falls back to the creation date", () => {
    expect(autoTitleFor("![img](/blob/x.png)", hlc)).toBe("2026年8月28日");
    expect(autoTitleFor("```\ncode\n```", hlc)).toBe("2026年8月28日");
  });
});

describe("isAutoTitleState", () => {
  const hlc = hlcAt(new Date(2026, 7, 27, 10)); // created "yesterday"

  test("empty title is auto", () => {
    expect(isAutoTitleState("", "anything", hlc)).toBe(true);
  });

  test("title equal to current derivation is auto", () => {
    expect(isAutoTitleState("买牛奶", "买牛奶\n明天", hlc)).toBe(true);
  });

  test("date-fallback title stays auto across days (created_hlc, not today)", () => {
    // The note was created yesterday and carries yesterday's date title; the
    // body has since gained a derivable first line. Still auto: the date arm
    // matches, so the title upgrades to the derived text on the next save.
    expect(isAutoTitleState("2026年8月27日", "新的首行", hlc)).toBe(true);
  });

  test("hand-edited title is manual", () => {
    expect(isAutoTitleState("购物清单", "买牛奶\n明天", hlc)).toBe(false);
  });
});
