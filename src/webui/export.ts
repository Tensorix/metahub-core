import { toCsv } from "../core/csv.ts";
import { api, type Prop, type Rec } from "./api.ts";
import { recordTitle } from "./relation-titles.ts";

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

/** propId → (targetId → title) for every relation/doc column, fetched fresh so
 *  the export is complete regardless of the title caches' warmth. A target that
 *  fails to load yields an empty map — those cells fall back to raw ids instead
 *  of failing the whole export. Doc columns share one global document-title map. */
export async function relationTitleMaps(props: readonly Prop[]): Promise<Map<string, Map<string, string>>> {
  const maps = new Map<string, Map<string, string>>();
  let docTitles: Promise<Map<string, string>> | null = null;
  for (const p of props) {
    if (p.type !== "doc") continue;
    docTitles ??= api
      .listDocuments()
      .then((docs) => {
        const m = new Map<string, string>();
        for (const d of docs) if (d.title) m.set(d.id, d.title);
        return m;
      })
      .catch(() => new Map<string, string>());
    maps.set(p.id, await docTitles);
  }
  const byTarget = new Map<string, Promise<Map<string, string>>>();
  for (const p of props) {
    const target = p.type === "relation" ? p.config?.database : undefined;
    if (!target) continue;
    if (!byTarget.has(target)) {
      byTarget.set(
        target,
        Promise.all([api.listProperties(target), api.listRecords(target)])
          .then(([tp, recs]) => {
            const m = new Map<string, string>();
            for (const r of recs) {
              const t = recordTitle(tp, r);
              if (t) m.set(r.id, t);
            }
            return m;
          })
          .catch(() => new Map<string, string>()),
      );
    }
    maps.set(p.id, await byTarget.get(target)!);
  }
  return maps;
}

export function databaseToCsv(
  props: readonly Prop[],
  records: readonly Rec[],
  relTitles?: Map<string, Map<string, string>>,
): string {
  const header = ["id", ...props.map((p) => p.name)];
  const rows = records.map((r) => [
    r.id,
    ...props.map((p) =>
      p.type === "relation" || p.type === "doc"
        ? relationToString(r.cells[p.id], relTitles?.get(p.id))
        : cellToString(r.cells[p.id]),
    ),
  ]);
  return toCsv([header, ...rows]);
}

/** Relation cells export as ", "-joined titles (id fallback per value) — the
 *  same readable form the CLI's CSV sync writes, and one its importer resolves
 *  back by name. */
function relationToString(value: unknown, titles?: Map<string, string>): string {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  return arr.map((v) => titles?.get(String(v)) ?? String(v)).join(", ");
}

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
