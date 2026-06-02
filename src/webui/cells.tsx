/** @jsxImportSource preact */
// Shared cell-value rendering helpers used by the table grid and the
// board / calendar / timeline views. Kept in their own module so the views
// can reuse them without importing from table.tsx (which would be circular).
import type { Prop, PropType } from "./api.ts";

// ---- option colors (stable per string) ----
const HUES = [4, 28, 45, 130, 165, 200, 220, 255, 290, 330];
export function optColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${HUES[h % HUES.length]} 65% 45%)`;
}

export function Chip({ text }: { text: string }) {
  return <span class="chip" style={{ ["--c" as any]: optColor(text) }}>{text}</span>;
}

export function CellDisplay({ prop, val }: { prop: Prop; val: unknown }) {
  if (val == null || val === "" || (Array.isArray(val) && val.length === 0))
    return <span class="muted">&nbsp;</span>;
  if (prop.type === "select") return <Chip text={String(val)} />;
  if (prop.type === "multi_select" || prop.type === "relation")
    return <>{(val as unknown[]).map((x) => <Chip key={String(x)} text={String(x)} />)}</>;
  if (prop.type === "url")
    return <a href={String(val)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{String(val)}</a>;
  return <span>{String(val)}</span>;
}

export function coerceInput(type: PropType, raw: string): unknown {
  if (type === "relation") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return raw;
}

export function cellText(_prop: Prop, val: unknown): string {
  if (val == null) return "";
  if (Array.isArray(val)) return val.join(", ");
  return String(val);
}
