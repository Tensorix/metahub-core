export type Locale = "zh-CN" | "en";

export const LANG_COOKIE = "mh-lang";

export const isLocale = (v: unknown): v is Locale => v === "zh-CN" || v === "en";

export function localeFromTags(tags: readonly (string | undefined | null)[] | undefined): Locale {
  if (!tags || tags.length === 0) return "zh-CN";
  for (const tag of tags) {
    if (!tag) continue;
    if (/^zh\b/i.test(tag)) return "zh-CN";
    if (/^en\b/i.test(tag)) return "en";
  }
  return "en";
}

export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return "zh-CN";
  return localeFromTags(header.split(",").map((s) => s.split(";")[0]!.trim()));
}

export function localeFromCookie(header: string | null | undefined): Locale | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LANG_COOKIE) continue;
    const v = decodeURIComponent(part.slice(eq + 1).trim());
    return isLocale(v) ? v : null;
  }
  return null;
}

export function pickLocale(req: Request): Locale {
  return localeFromCookie(req.headers.get("cookie")) ?? localeFromAcceptLanguage(req.headers.get("accept-language"));
}
