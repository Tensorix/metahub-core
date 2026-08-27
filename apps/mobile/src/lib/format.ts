import type { PropInfo, RecordInfo } from "./api/sdk";

/** The first text property is the de-facto title column (mirrors core's
 *  resolve.ts convention). */
export function titleProp(props: PropInfo[]): PropInfo | null {
  return props.find((p) => p.type === "text") ?? null;
}

export function recordTitle(rec: RecordInfo, props: PropInfo[]): string {
  const tp = titleProp(props);
  const v = tp ? rec.cells[tp.id] : null;
  return typeof v === "string" && v.trim() ? v : "未命名";
}

export function selectOptions(prop: PropInfo): string[] {
  const opts = prop.config?.options;
  return Array.isArray(opts) ? opts.filter((o): o is string => typeof o === "string") : [];
}

/** Compact display string for a cell value, for record-card subtitles. */
export function cellText(prop: PropInfo, value: unknown): string | null {
  if (value == null || value === "") return null;
  switch (prop.type) {
    case "checkbox":
      return value ? "☑" : null;
    case "multi_select":
      return Array.isArray(value) ? value.join(" · ") : String(value);
    case "date":
      return formatDate(String(value));
    case "relation":
    case "doc":
      return null; // needs cross-db title resolution — skip on cards
    default:
      return String(value);
  }
}

export function formatDate(iso: string): string {
  // Values are YYYY-MM-DD (or ISO datetime); render compact Chinese style.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const now = new Date();
  const sameYear = String(now.getFullYear()) === m[1];
  return sameYear ? `${Number(m[2])}月${Number(m[3])}日` : `${m[1]}/${m[2]}/${m[3]}`;
}

/** Stable chip tint per option string (mirrors the WebUI's hashed palette). */
const CHIP_COLORS = [
  "#e8f0fe", "#fde8e8", "#e6f4ea", "#fef3e2", "#f3e8fd", "#e0f2f1", "#fce4ec", "#f1f1ef",
];
const CHIP_COLORS_DARK = [
  "#23304a", "#42272b", "#1f3a2a", "#443320", "#37294a", "#1e3a38", "#442b36", "#2a2a2d",
];
export function chipColor(option: string, scheme: "light" | "dark"): string {
  let h = 0;
  for (let i = 0; i < option.length; i++) h = (h * 31 + option.charCodeAt(i)) >>> 0;
  const palette = scheme === "dark" ? CHIP_COLORS_DARK : CHIP_COLORS;
  return palette[h % palette.length]!;
}
