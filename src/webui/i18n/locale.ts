import { LANG_COOKIE, isLocale, localeFromTags, type Locale } from "../../core/sync/locale.ts";

export { localeFromTags, localeFromAcceptLanguage, type Locale } from "../../core/sync/locale.ts";
export type LangChoice = "system" | Locale;

export const LANG_KEY = LANG_COOKIE;
export const LOCALES: readonly Locale[] = ["zh-CN", "en"];
export const LOCALE_NAMES: Record<Locale, string> = { "zh-CN": "简体中文", en: "English" };

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function getLang(): LangChoice {
  const v = storage()?.getItem(LANG_KEY);
  return isLocale(v) ? v : "system";
}

export function systemLocale(): Locale {
  if (typeof navigator === "undefined") return "zh-CN";
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  return localeFromTags(tags);
}

function queryLocale(): Locale | null {
  if (typeof location === "undefined") return null;
  const v = new URLSearchParams(location.search).get("lang");
  return isLocale(v) ? v : null;
}

let cached: Locale | null = null;
let override: Locale | null = null;

function compute(): Locale {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return "zh-CN";
  const q = queryLocale();
  if (q) return q;
  const choice = getLang();
  return choice === "system" ? systemLocale() : choice;
}

export function resolveLocale(): Locale {
  if (override) return override;
  if (!cached) cached = compute();
  return cached;
}

export function setLocaleOverride(l: Locale | null): void {
  override = l;
  cached = null;
}

export function setLang(choice: LangChoice): Locale {
  const s = storage();
  if (choice === "system") s?.removeItem(LANG_KEY);
  else s?.setItem(LANG_KEY, choice);
  if (typeof document !== "undefined") {
    document.cookie =
      choice === "system"
        ? `${LANG_KEY}=; path=/; SameSite=Strict; Max-Age=0`
        : `${LANG_KEY}=${choice}; path=/; SameSite=Strict; Max-Age=31536000`;
  }
  cached = null;
  const l = resolveLocale();
  if (typeof document !== "undefined") document.documentElement.lang = l;
  return l;
}
