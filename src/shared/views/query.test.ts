import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../core/schema-init.ts";
import { createReplicaService } from "../../core/replica/service.ts";
import { listRecords } from "../../core/records.ts";
import { applyFilter, applySort, normalizeViews, searchRecords } from "./model.ts";
import { normalizeViews as browserNormalize } from "../../webui/view-model.ts";
import { queryDocuments, queryRecords, queryRecordsAsync } from "./query.ts";
const handles: Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
function fixture(count = 10000) {
  const db = new Database(":memory:"); handles.push(db); initSchema(db);
  const service = createReplicaService(db);
  const database = service.commands.createDatabase({name: "Large"});
  const title = service.commands.addProperty(database.id, {name: "Title", type: "text"});
  const n = service.commands.addProperty(database.id, {name: "Number", type: "number"});
  const insert = db.query("INSERT INTO records (id,database_id,order_key,data) VALUES (?,?,?,?)");
  db.transaction(() => { for (let i=0;i<count;i++) insert.run(`rec_${String(i).padStart(5,"0")}`, database.id, String(i).padStart(5,"0"), JSON.stringify({[title.id]: i > 9500 ? "find me" : "else", [n.id]: i % 17})); })();
  return {db,service,database,props:[title,n],title,n};
}
test("saved view normalization matches browser and retains unknown keys", () => {
  const raw = [{id:"v",name:"Example",layout:"calendar",future:{color:"blue"},sort:[{prop:"missing",desc:true,future:5}],filter:{op:"or",rules:[{prop:"missing",cond:"future",extra:3}]},hidden:["unknown"],dateProp:"gone"}];
  expect(normalizeViews(raw)).toEqual(browserNormalize(raw));
  expect(normalizeViews(raw)[0]?.future).toEqual({color:"blue"});
  expect(normalizeViews([{id:"bad",layout:"future"}])).toEqual(browserNormalize([{id:"bad",layout:"future"}]));
});
test("10k query filters and sorts all rows before slicing with stable multi-key ties", () => {
  const f = fixture();
  const query = {search:"find me",filter:{op:"and" as const,rules:[{id:"f",prop:f.n.id,cond:"gt",value:4}]},sort:[{prop:f.n.id,desc:true},{prop:f.title.id,desc:false}],offset:60,limit:60};
  const all = applySort(applyFilter(searchRecords(listRecords(f.db,f.database.id),f.props,query.search),f.props,query.filter),f.props,query.sort);
  const result = queryRecords(f.db,f.database.id,query);
  expect(result.records).toEqual(all.slice(60,120)); expect(result.total).toBe(all.length); expect(result.hasMore).toBe(true);
  expect(queryRecords(f.db,f.database.id,{offset:9960,limit:60}).records).toHaveLength(40);
});
test("async scans yield and respect disposal without touching a closed replica", async () => {
  const f = fixture(1000); let yielded = false; setTimeout(() => {yielded = true;},0);
  expect((await queryRecordsAsync(f.db,f.database.id,{limit:20})).records).toHaveLength(20); expect(yielded).toBe(true);
  const pending = f.service.client.queryRecords(f.database.id,{limit:20});
  f.service.dispose(); await expect(pending).rejects.toThrow("cancelled");
});

test("document picker search and page stay bounded and escape LIKE wildcards", () => {
  const f = fixture(0);
  for (let i=0;i<75;i++) f.service.commands.createDocument({title:i === 74 ? "Unique 100%_" : "Document"});
  expect(queryDocuments(f.db,{limit:60}).documents).toHaveLength(60);
  expect(queryDocuments(f.db,{offset:60,limit:60}).documents).toHaveLength(15);
  const found = queryDocuments(f.db,{search:"100%_"});
  expect(found.total).toBe(1); expect(found.documents[0]?.title).toBe("Unique 100%_");
  expect(found.documents[0]).not.toHaveProperty("body");
});

test("manual pages preserve null ordering, deletions, empty predicates and full total", async () => {
  const f = fixture(1000);
  f.db.query("UPDATE records SET __deleted = 1 WHERE id = ?").run("rec_00005");
  f.db.query("UPDATE records SET order_key = NULL WHERE id = ?").run("rec_00001");
  const all = listRecords(f.db, f.database.id);
  const page = await queryRecordsAsync(f.db, f.database.id, { offset: 980, limit: 60, search: "  ", filter: {op: "or", rules: []}, sort: [{prop: "missing", desc: false}] });
  expect(page.records).toEqual(all.slice(980));
  expect(page.total).toBe(999);
  expect(page.hasMore).toBe(false);
  expect(page.records.at(-1)?.id).toBe("rec_00001");
});
