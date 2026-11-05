import type { DbDriver } from "../../../../../src/core/driver";
export type LibraryKind = "documents" | "databases";
type Item = {
  id: string;
  title: string;
  sort: string | null;
  child: number;
  parent_id: string | null;
  path?: string;
};
export type Row = {
  key: string;
  title: string;
  depth: number;
  branch: string | null;
  more?: boolean;
  error?: boolean;
  expanded?: boolean;
  children?: boolean;
  path?: string;
};
const batch = 60;

export function readLibrary(
  db: DbDriver,
  kind: LibraryKind,
  search: string,
  parent: string | null,
  after?: Item,
) {
  const docs = kind === "documents";
  const sort = docs ? "d.order_key" : "d.created_hlc";
  const title = docs ? "d.title" : "d.name";
  const where = ["d.__deleted=0"];
  const args: (string | number)[] = [];
  if (search) {
    where.push(`(${title} LIKE ? ESCAPE '\\' OR d.id LIKE ? ESCAPE '\\')`);
    const like = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
    args.push(like, like);
  } else if (docs && parent !== null) {
    where.push("d.parent_id=?");
    args.push(parent);
  } else if (docs)
    where.push(
      "(d.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM documents p WHERE p.id=d.parent_id AND p.__deleted=0))",
    );
  if (after) {
    where.push(`((${sort} IS NULL),coalesce(${sort},''),d.id) > (?,?,?)`);
    args.push(Number(after.sort === null), after.sort ?? "", after.id);
  }
  const child =
    docs && !search
      ? "EXISTS(SELECT 1 FROM documents c WHERE c.parent_id=d.id AND c.__deleted=0)"
      : "0";
  const items = db
    .query(
      `SELECT d.id,${title} AS title,${sort} AS sort,${child} AS child,${docs ? "d.parent_id" : "NULL"} AS parent_id FROM ${kind} d WHERE ${where.join(" AND ")} ORDER BY ${sort} IS NULL,${sort},d.id LIMIT 61`,
    )
    .all(...args) as Item[];
  const rows = items.slice(0, batch);
  if (docs && search) {
    const parents = new Map<
      string,
      { title: string; parent_id: string | null } | null
    >();
    for (const row of rows) {
      const names: string[] = [],
        seen = new Set([row.id]);
      let id = row.parent_id;
      while (id && !seen.has(id)) {
        seen.add(id);
        if (!parents.has(id))
          parents.set(
            id,
            db
              .query(
                "SELECT title,parent_id FROM documents WHERE id=? AND __deleted=0",
              )
              .get(id) as Item | null,
          );
        const p = parents.get(id);
        if (!p) break;
        names.unshift(p.title || "未命名");
        id = p.parent_id;
      }
      row.path = names.join(" › ");
    }
  }
  return { rows, more: items.length > batch };
}

export class LibraryTree {
  readonly expanded = new Set<string>();
  private pages = new Map<string | null, ReturnType<typeof readLibrary>>();
  private errors = new Set<string | null>();
  constructor(
    private db: DbDriver,
    readonly kind: LibraryKind,
    readonly search: string,
  ) {
    this.load(null);
  }
  load(parent: string | null) {
    const page = this.pages.get(parent);
    if (page && !page.more) return;
    try {
      const next = readLibrary(
        this.db,
        this.kind,
        this.search,
        parent,
        page?.rows.at(-1),
      );
      this.pages.set(parent, {
        rows: [...(page?.rows ?? []), ...next.rows],
        more: next.more,
      });
      this.errors.delete(parent);
    } catch {
      this.errors.add(parent);
    }
  }
  toggle(id: string) {
    if (!this.expanded.delete(id)) {
      this.expanded.add(id);
      if (!this.pages.has(id)) this.load(id);
    }
  }
  refresh() {
    const old = this.pages;
    this.pages = new Map();
    const branches = new Set([null, ...old.keys(), ...this.errors]);
    this.errors.clear();
    for (const branch of branches) {
      const count = Math.max(
        1,
        Math.ceil((old.get(branch)?.rows.length ?? 0) / batch),
      );
      for (let i = 0; i < count; i++) {
        this.load(branch);
        if (this.errors.has(branch)) {
          const previous = old.get(branch);
          if (previous) this.pages.set(branch, previous);
          break;
        }
        if (!this.pages.get(branch)?.more) break;
      }
    }
  }
  rows() {
    const result: Row[] = [],
      seen = new Set<string>();
    const visit = (branch: string | null, depth: number) => {
      const page = this.pages.get(branch);
      for (const doc of page?.rows ?? []) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        const expanded = this.expanded.has(doc.id);
        result.push({
          key: doc.id,
          title: doc.title || "未命名",
          branch,
          depth,
          children: !!doc.child,
          expanded,
          path: doc.path,
        });
        if (expanded && doc.child) visit(doc.id, depth + 1);
      }
      if (page?.more || this.errors.has(branch))
        result.push({
          key:
            "more:" +
            JSON.stringify([
              branch,
              page?.rows.at(-1)?.id,
              this.errors.has(branch),
            ]),
          title: this.errors.has(branch) ? "读取失败，点按重试" : "正在载入…",
          branch,
          depth,
          more: true,
          error: this.errors.has(branch),
        });
    };
    visit(null, 0);
    return result;
  }
}

/** When a visible document moves away, prefer its next surviving sibling in
 * screen order. A deleted trailing row falls back toward the preceding rows. */
export function replacementAnchor(
  key: string | null,
  previous: Row[],
  next: Row[],
) {
  if (!key || previous === next) return null;
  const remaining = new Set(
    next.filter((row) => !row.more).map((row) => row.key),
  );
  if (remaining.has(key)) return null;
  const at = previous.findIndex((row) => row.key === key);
  if (at === -1) return null;
  for (let distance = 1; distance < previous.length; distance++) {
    for (const index of [at + distance, at - distance]) {
      const candidate = previous[index]?.key;
      if (candidate && remaining.has(candidate)) return candidate;
    }
  }
  return next.find((row) => !row.more)?.key ?? null;
}
