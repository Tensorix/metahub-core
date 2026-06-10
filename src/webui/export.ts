import { toCsv } from "../core/csv.ts";
import type { Prop, Rec } from "./api.ts";

export function safeFilename(name: string, ext: string): string {
  const suffix = ext.startsWith(".") ? ext : "." + ext;
  const base =
    name
      .trim()
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^\.+$/, "")
      .slice(0, 90) || "untitled";
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : base + suffix;
}

export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function databaseToCsv(props: readonly Pick<Prop, "id" | "name">[], records: readonly Rec[]): string {
  const header = ["id", ...props.map((p) => p.name)];
  const rows = records.map((r) => [r.id, ...props.map((p) => cellToString(r.cells[p.id]))]);
  return toCsv([header, ...rows]);
}

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
