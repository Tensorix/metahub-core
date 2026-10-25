import type { DocSummaryInfo } from "./api/sdk";
export interface DocRow {
  kind: "doc";
  doc: DocSummaryInfo;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Flatten the parent_id doc tree honoring the expand set. Docs attached to a
 *  database don't belong in the sidebar tree (they surface via their db). */
export function flattenDocs(docs: DocSummaryInfo[], expanded: Set<string>): DocRow[] {
  const children = new Map<string | null, DocSummaryInfo[]>();
  for (const d of docs) {
    if (d.database_id) continue;
    const key = d.parent_id;
    const list = children.get(key);
    if (list) list.push(d);
    else children.set(key, [d]);
  }
  const out: DocRow[] = [];
  const visited = new Set<string>(), reachable = new Set<string>();
  const standalone = docs.filter(d => !d.database_id), known = new Set(standalone.map(d => d.id));
  const roots = standalone.filter(d => d.parent_id === null || !known.has(d.parent_id));
  const mark = (root: DocSummaryInfo) => {
    const stack = [root];
    while (stack.length) { const d = stack.pop()!; if (reachable.has(d.id)) continue; reachable.add(d.id); for (const child of children.get(d.id) ?? []) stack.push(child); }
  };
  const walk = (roots: DocSummaryInfo[]) => {
    const stack = roots.slice().reverse().map(doc => ({doc, depth:0}));
    while (stack.length) {
      const {doc, depth} = stack.pop()!;
      if (visited.has(doc.id)) continue;
      visited.add(doc.id);
      const kids = children.get(doc.id) ?? [], open = expanded.has(doc.id);
      out.push({kind: "doc", doc, depth, hasChildren: kids.length > 0, expanded: open});
      if (open) for (const child of kids.slice().reverse()) stack.push({doc: child, depth: depth + 1});
    }
  };
  walk(roots); for (const root of roots) mark(root);
  for (const doc of standalone) if (!reachable.has(doc.id)) { walk([doc]); mark(doc); }
  return out;
}
