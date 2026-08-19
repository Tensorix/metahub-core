/** @jsxImportSource preact */
// Shared cell-value rendering helpers used by the table grid and the
// board / calendar / timeline views. Kept in their own module so the views
// can reuse them without importing from table.tsx (which would be circular).
import { useEffect, useRef, useState } from "preact/hooks";
import type { Prop, PropType } from "./api.ts";
import { relationTitle, onRelationTitleChange } from "./relation-titles.ts";

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

/** Chip label for a relation value: the target record's title, "无标题" for a
 *  titled-but-empty record, and a shortened raw id while loading / for dangling
 *  refs / when the target db has no text property. */
export function relationLabel(dbId: string | undefined, recId: string): string {
  const t = relationTitle(dbId, recId);
  if (t) return t;
  if (t === "") return "无标题";
  return recId.length > 15 ? `${recId.slice(0, 14)}…` : recId;
}

/** One relation chip: shows the target record's title and links to it. Plain
 *  anchor navigation — the app's hashchange listener does the rest, and the
 *  grid's cell-select / board drag handlers already ignore clicks on `a`.
 *  Subscribes itself to the title cache, so every consumer (grid, peek, board
 *  cards) updates on cache changes with zero view-level wiring. */
function RelChip({ dbId, recId }: { dbId: string | undefined; recId: string }) {
  const [, bump] = useState(0);
  const label = relationLabel(dbId, recId);
  const labelRef = useRef(label);
  labelRef.current = label;
  useEffect(() => {
    const un = onRelationTitleChange(() => bump((n) => n + 1));
    // A loopback fetch can finish before deferred effects run — the cache's
    // load notification would land BEFORE this subscription. Re-check now.
    if (relationLabel(dbId, recId) !== labelRef.current) bump((n) => n + 1);
    return un;
  }, []);
  return (
    <a
      class="chip rel"
      style={{ ["--c" as any]: optColor(label) }}
      href={`#/db/${encodeURIComponent(dbId ?? "")}/${encodeURIComponent(recId)}`}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );
}

export function CellDisplay({ prop, val }: { prop: Prop; val: unknown }) {
  if (val == null || val === "" || (Array.isArray(val) && val.length === 0))
    return <span class="muted">&nbsp;</span>;
  if (prop.type === "select") return <Chip text={String(val)} />;
  if (prop.type === "relation")
    return <>{(val as unknown[]).map((x) => <RelChip key={String(x)} dbId={prop.config?.database} recId={String(x)} />)}</>;
  if (prop.type === "multi_select")
    return <>{(val as unknown[]).map((x) => <Chip key={String(x)} text={String(x)} />)}</>;
  if (prop.type === "url")
    return <a href={String(val)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{String(val)}</a>;
  return <span>{String(val)}</span>;
}

export function coerceInput(_type: PropType, raw: string): unknown {
  // relation never reaches here — it edits through the record picker.
  return raw;
}

export function cellText(prop: Prop, val: unknown): string {
  if (val == null) return "";
  if (Array.isArray(val)) {
    // Copy relations as titles (what the user sees); ids only as fallback for
    // cold-cache / dangling entries. Note there is no table paste path, so
    // copied titles are for humans, not round-tripping.
    if (prop.type === "relation")
      return val.map((x) => relationTitle(prop.config?.database, String(x)) || String(x)).join(", ");
    return val.join(", ");
  }
  return String(val);
}
