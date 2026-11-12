import type { RecentItem } from "./recent";

export interface RecentContentItem {
  id: string;
  kind: "document" | "database";
  title: string;
}

/** Resolve current names, omit deleted items, and retain cross-kind visit order. */
export function recentContent(
  items: RecentItem[],
  documents: { id: string; title: string | null; missing?: boolean }[],
  databases: { id: string; name: string }[],
): RecentContentItem[] {
  const docs = new Map(
    documents.filter((d) => !d.missing).map((d) => [d.id, d.title ?? ""]),
  );
  const tables = new Map(databases.map((d) => [d.id, d.name]));
  return items
    .flatMap((item): RecentContentItem[] => {
      if (item.kind !== "document" && item.kind !== "database") return [];
      const title = (item.kind === "document" ? docs : tables).get(item.id);
      return title === undefined
        ? []
        : [{ id: item.id, kind: item.kind, title }];
    })
    .slice(0, 12);
}
