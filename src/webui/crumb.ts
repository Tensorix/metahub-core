// Top-down location of a document: [owning database] › ancestors (self excluded).
import type { Db, DocSummary } from "./api.ts";
import { t } from "./i18n/t.ts";

export interface CrumbSeg {
  kind: "db" | "doc";
  id: string;
  label: string;
}

export function docPath(id: string, docs: DocSummary[], dbs: Db[]): CrumbSeg[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out: CrumbSeg[] = [];
  let cur = byId.get(id);
  const seen = new Set<string>([id]);
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    cur = byId.get(cur.parent_id);
    if (cur) out.unshift({ kind: "doc", id: cur.id, label: cur.title || t("无标题") });
  }
  const dbId = cur?.database_id ?? byId.get(id)?.database_id;
  if (dbId) {
    const db = dbs.find((d) => d.id === dbId);
    out.unshift({ kind: "db", id: dbId, label: db?.name || t("未命名数据库") });
  }
  return out;
}

export function dbName(id: string, dbs: Db[]): string {
  return dbs.find((d) => d.id === id)?.name || t("未命名数据库");
}
