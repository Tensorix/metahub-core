import { en } from "./en.ts";
import { resolveLocale, type Locale } from "./locale.ts";

export type Params = Record<string, string | number>;
export type MsgKey = keyof typeof en;

function interpolate(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

const CTX = "##";

export function tIn<K extends MsgKey>(locale: Locale, key: K, params?: Params): string {
  const v = locale === "en" ? (en[key] as string | ((p: Params) => string) | undefined) : undefined;
  if (typeof v === "function") return v(params ?? {});
  const i = key.indexOf(CTX);
  return interpolate(v ?? (i < 0 ? key : key.slice(0, i)), params);
}

export function t<K extends MsgKey>(key: K, params?: Params): string {
  return tIn(resolveLocale(), key, params);
}
