import { test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { en } from "./en.ts";
import { t, tIn } from "./t.ts";
import { localeFromAcceptLanguage, localeFromTags, resolveLocale, setLocaleOverride } from "./locale.ts";

const ROOT = join(import.meta.dir, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") sources(p, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || /\.d\.ts$/.test(name)) continue;
    out.push(p);
  }
  return out;
}

const STR = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|` + "`((?:[^`\\\\$]|\\\\.)*)`";
const CALL = new RegExp(String.raw`(?<![\w$.])(?:t\(|tIn\([^,]*,)\s*(?:${STR})`, "g");
const SHADOW = /(?<![\w$.])(?:const|let|var)\s+t\b|\(\s*t\s*[,)]|,\s*t\s*\)|\bt\s*=>/;

function keysIn(src: string): string[] {
  const keys: string[] = [];
  for (const m of src.matchAll(CALL)) keys.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c)));
  return keys;
}

afterEach(() => setLocaleOverride(null));

test("every t() key in src/webui has an English entry and every entry is used", () => {
  const used = new Set<string>();
  const missing: string[] = [];
  for (const file of sources(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const k of keysIn(src)) {
      used.add(k);
      if (!(k in en)) missing.push(`${relative(ROOT, file)}: ${k}`);
    }
  }
  expect(missing).toEqual([]);
  const unused = Object.keys(en).filter((k) => !used.has(k));
  expect(unused).toEqual([]);
});

test("files that import t() do not shadow it with a local t", () => {
  const offenders: string[] = [];
  for (const file of sources(ROOT)) {
    const src = readFileSync(file, "utf8");
    if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n\/t\.ts["']/.test(src)) continue;
    if (SHADOW.test(src)) offenders.push(relative(ROOT, file));
  }
  expect(offenders).toEqual([]);
});

test("t() returns the key under zh-CN and the translation under en", () => {
  expect(resolveLocale()).toBe("zh-CN");
  expect(t("{n} 分钟前", { n: 5 })).toBe("5 分钟前");
  setLocaleOverride("en");
  expect(t("{n} 分钟前", { n: 1 })).toBe("1 minute ago");
  expect(t("{n} 分钟前", { n: 5 })).toBe("5 minutes ago");
  expect(t("快照 {when}", { when: "x" })).toBe("Snapshot x");
  expect(tIn("zh-CN", "快照 {when}", { when: "x" })).toBe("快照 x");
});

test("a ##context suffix picks a distinct English entry and never leaks into zh", () => {
  expect(t("设备##page")).toBe("设备");
  expect(t("撤销##audit")).toBe("撤销");
  setLocaleOverride("en");
  expect(t("设备##page")).toBe("Devices");
  expect(t("设备")).toBe("Device");
  expect(t("撤销##audit")).toBe("Undo");
  expect(t("撤销")).toBe("Revoke");
});

test("locale negotiation takes the first supported tag", () => {
  expect(localeFromTags(["zh-CN", "en"])).toBe("zh-CN");
  expect(localeFromTags(["en-US", "zh-CN"])).toBe("en");
  expect(localeFromTags(["zh-TW"])).toBe("zh-CN");
  expect(localeFromTags(["ja-JP"])).toBe("en");
  expect(localeFromTags([])).toBe("zh-CN");
  expect(localeFromAcceptLanguage("en-US,en;q=0.9,zh;q=0.8")).toBe("en");
  expect(localeFromAcceptLanguage("zh-CN,zh;q=0.9")).toBe("zh-CN");
  expect(localeFromAcceptLanguage(null)).toBe("zh-CN");
});
