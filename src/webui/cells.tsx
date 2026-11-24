/** @jsxImportSource preact */
// Shared cell-value rendering helpers used by the table grid and the
// board / calendar / timeline views. Kept in their own module so the views
// can reuse them without importing from table.tsx (which would be circular).
import { useEffect, useRef, useState } from "preact/hooks";
import type { Prop, PropType } from "./api.ts";
import { relationTitle, onRelationTitleChange } from "./relation-titles.ts";
import { docLinkTitle, onDocTitleChange } from "./doc-titles.ts";
import { t } from "./i18n/t.ts";
import { Icon } from "./icons.tsx";

import { optColor } from "./option-color.ts";
export { optColor } from "./option-color.ts";

export function Chip({ text }: { text: string }) {
  return <span class="chip" style={{ ["--c" as any]: optColor(text) }}>{text}</span>;
}

export const colWidth = (p: Prop) => p.config?.width ?? 180;

export function referenceLabel(id: string, title: string | null | undefined): string {
  if (title === "") return t("无标题");
  return title || (id.length > 15 ? `${id.slice(0, 14)}…` : id);
}

/** Chip label for a relation value: the target record's title, "无标题" for a
 *  titled-but-empty record, and a shortened raw id while loading / for dangling
 *  refs / when the target db has no text property. */
export function relationLabel(dbId: string | undefined, recId: string): string {
  return referenceLabel(recId, relationTitle(dbId, recId));
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

/** Chip label for a doc value: the document's title, "无标题" for an existing
 *  but untitled document, and a shortened raw id while loading / for dangling
 *  refs (deleted or unsynced documents). */
export function docLabel(docId: string): { label: string; missing: boolean } {
  const title = docLinkTitle(docId);
  return { label: referenceLabel(docId, title), missing: title === null };
}

/** One doc chip: shows the document's title and links to it. Same anchor-based
 *  navigation and self-subscription idiom as RelChip, but fed by the global
 *  doc-title map (primed for free by App.reloadNav). A dangling ref renders in
 *  the missing style instead of hiding — the id is the user's only handle. */
function DocChip({ docId }: { docId: string }) {
  const [, bump] = useState(0);
  const { label, missing } = docLabel(docId);
  const labelRef = useRef(label);
  labelRef.current = label;
  useEffect(() => {
    const un = onDocTitleChange(() => bump((n) => n + 1));
    if (docLabel(docId).label !== labelRef.current) bump((n) => n + 1);
    return un;
  }, []);
  return (
    <a
      class={missing ? "chip rel doc-missing" : "chip rel"}
      style={{ ["--c" as any]: optColor(label) }}
      href={`#/doc/${encodeURIComponent(docId)}`}
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
  if (prop.type === "doc")
    return <>{(val as unknown[]).map((x) => <DocChip key={String(x)} docId={String(x)} />)}</>;
  if (prop.type === "multi_select")
    return <>{(val as unknown[]).map((x) => <Chip key={String(x)} text={String(x)} />)}</>;
  if (prop.type === "url")
    return (
      <a class="cell-url" href={String(val)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        <span>{String(val)}</span>
        <Icon name="externalLink" cls="ico sm" />
      </a>
    );
  if (prop.type === "number") return <span class="num">{String(val)}</span>;
  return <span class="txt">{String(val)}</span>;
}

export function coerceInput(type: PropType, raw: string): unknown {
  if (type === "number") {
    const s = raw.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

/** Types safely editable through a bare contentEditable (board card titles,
 *  the peek <h2>). Only free-text types qualify: number/date rely on
 *  `<input type=…>` shaping (coerceInput is identity), and checkbox/select/
 *  multi_select/relation/doc edit through pickers. */
export function isPlainTextEditable(pt: PropType): boolean {
  return pt === "text" || pt === "url";
}

export function cellText(prop: Prop, val: unknown): string {
  if (val == null) return "";
  if (Array.isArray(val)) {
    // Copy relations as titles (what the user sees); ids only as fallback for
    // cold-cache / dangling entries. Note there is no table paste path, so
    // copied titles are for humans, not round-tripping.
    if (prop.type === "relation")
      return val.map((x) => relationTitle(prop.config?.database, String(x)) || String(x)).join(", ");
    if (prop.type === "doc")
      return val.map((x) => docLinkTitle(String(x)) || String(x)).join(", ");
    return val.join(", ");
  }
  return String(val);
}
