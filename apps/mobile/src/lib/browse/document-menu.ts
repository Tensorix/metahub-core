import type { DbDriver } from "../../../../../src/core/driver";

export type DocumentMenuAction =
  "child" | "copy-id" | "rename" | "move-root" | "delete";
export interface DocumentMenuItem {
  id: DocumentMenuAction;
  title: string;
  symbol: "plus" | "number" | "pencil" | "arrow.up.right" | "trash";
  destructive?: boolean;
}
export function documentMenuItems(hasParent: boolean): DocumentMenuItem[] {
  return [
    { id: "child", title: "新建子页", symbol: "plus" },
    { id: "copy-id", title: "复制 ID", symbol: "number" },
    { id: "rename", title: "重命名…", symbol: "pencil" },
    ...(hasParent
      ? [
          {
            id: "move-root" as const,
            title: "移到顶层",
            symbol: "arrow.up.right" as const,
          },
        ]
      : []),
    { id: "delete", title: "删除", symbol: "trash", destructive: true },
  ];
}
export function readDocumentMenu(db: DbDriver, id: string) {
  return db
    .query("SELECT title,parent_id FROM documents WHERE id=? AND __deleted=0")
    .get(id) as { title: string; parent_id: string | null } | null;
}

export function databaseMenuItems(): DocumentMenuItem[] {
  return [
    { id: "copy-id", title: "复制 ID", symbol: "number" },
    { id: "rename", title: "重命名…", symbol: "pencil" },
    { id: "delete", title: "删除数据库", symbol: "trash", destructive: true },
  ];
}

export function readDatabaseMenu(db: DbDriver, id: string) {
  return db
    .query(
      "SELECT name AS title,NULL AS parent_id FROM databases WHERE id=? AND __deleted=0",
    )
    .get(id) as { title: string; parent_id: null } | null;
}
