import { expect, test } from "bun:test";
import { flattenDocs } from "./doc-tree";
const doc = (id: string, parent_id: string | null, database_id: string | null = null) => ({id,parent_id,database_id,title:id});
test("tree handles orphan, self-cycle, disconnected cycles, and database-attached parents", () => {
  const docs = [doc("root",null),doc("child","root"),doc("orphan","gone"),doc("self","self"),doc("a","b"),doc("b","a"),doc("attached",null,"db"),doc("detached","attached")];
  const all = flattenDocs(docs,new Set(docs.map(d => d.id)));
  expect(new Set(all.map(row => row.doc.id)).size).toBe(7);
  expect(all.map(row => row.doc.id)).not.toContain("attached");
  expect(flattenDocs(docs,new Set()).map(row => row.doc.id)).not.toContain("child");
});
test("deep trees use an iterative walk", () => {
  const docs = Array.from({length:10000},(_,i) => doc(String(i),i ? String(i-1) : null));
  expect(flattenDocs(docs,new Set(docs.map(d=>d.id)))).toHaveLength(10000);
});
