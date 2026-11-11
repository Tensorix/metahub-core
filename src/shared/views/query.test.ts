import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../core/schema-init.ts";
import { createReplicaService } from "../../core/replica/service.ts";
import { listRecords } from "../../core/records.ts";
import { applyFilter, applySort, normalizeViews, searchRecords } from "./model.ts";
import { normalizeViews as browserNormalize } from "../../webui/view-model.ts";
import { createRecordQuerySessions, queryDocuments, queryRecords, queryRecordsAsync } from "./query.ts";
const handles: Database[] = [];
test("query sessions page a stable sorted index and invalidate on revision changes", async () => {
  const f = fixture(1000);
  let revision = 1;
  const sessions = createRecordQuerySessions(f.db, () => revision);
  const query = { sort: [{ prop: f.n.id, desc: true }], calc: { [f.n.id]: "sum" as const } };
  const opened = await sessions.open(f.database.id, query);
  const expected = applySort(listRecords(f.db, f.database.id), f.props, query.sort);
  const actual = [];
  for (let offset = 0; offset < opened.total; offset += 100)
    actual.push(...sessions.page(opened.id, offset).records);
  expect(actual).toEqual(expected);
  expect(opened.calc).toEqual(queryRecords(f.db, f.database.id, query).calc);
  expect(sessions.locate(opened.id, expected[301]!.id)).toBe(301);
  expect(() => sessions.page(opened.id, -1)).toThrow("Invalid");
  revision++;
  expect(() => sessions.page(opened.id)).toThrow("stale");
});
test("query session indexes preserve null manual order and can be cancelled or closed", async () => {
  const f = fixture(401);
  f.db.query("UPDATE records SET order_key = NULL WHERE id >= 'rec_00200'").run();
  const sessions = createRecordQuerySessions(f.db, () => 1);
  const opened = await sessions.open(f.database.id);
  const expected = queryRecords(f.db, f.database.id, { offset: 200, limit: 100 });
  expect(sessions.page(opened.id, 200).records).toEqual(expected.records);
  sessions.close(opened.id);
  expect(() => sessions.page(opened.id)).toThrow("stale");
  const pending = sessions.open(f.database.id);
  sessions.clear();
  await expect(pending).rejects.toThrow("cancelled");
});
test("query session page reads only requested IDs without another scan", async () => {
  const f = fixture(1000);
  const reads: string[] = [];
  const sessions = createRecordQuerySessions({ ...f.db, query(sql: string) { reads.push(sql); return f.db.query(sql); }, exec: sql => f.db.exec(sql), transaction: fn => f.db.transaction(fn) }, () => 1);
  const opened = await sessions.open(f.database.id, { search: "else" });
  reads.length = 0;
  expect(sessions.page(opened.id, 500).records).toHaveLength(100);
  expect(reads.filter(sql => sql.includes("FROM records"))).toHaveLength(1);
  expect(reads.find(sql => sql.includes("FROM records"))).toContain("id IN");
});
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

test("layout constraints AND the saved OR filter and aggregate all matching pages", () => {
  const f = fixture(10000);
  const group = f.service.commands.addProperty(f.database.id, {name:"Status",type:"select",config:{options:["Open","Done"]}});
  f.db.query("UPDATE records SET data = json_set(data, ?, ?) WHERE id >= ?").run(`$.${group.id}`, "Open", "rec_09500");
  const filter = {op:"or" as const,rules:[{id:"a",prop:f.n.id,cond:"eq",value:1},{id:"b",prop:f.n.id,cond:"eq",value:2}]};
  const all = applyFilter(listRecords(f.db,f.database.id), [...f.props,group],filter).filter(r => r.cells[group.id] === "Open");
  const result = queryRecords(f.db,f.database.id,{filter,group:{prop:group.id,value:"Open"},limit:3,calc:{[f.n.id]:"sum"}});
  expect(result.total).toBe(all.length);
  expect(result.records).toHaveLength(3);
  expect(Number(result.calc[f.n.id])).toBe(all.reduce((n,r)=>n+Number(r.cells[f.n.id]),0));
  expect(queryRecords(f.db,f.database.id,{group:{prop:group.id,value:null}}).total).toBe(9500);
});

test("date windows include crossing ranges, milestones, and separately query undated rows", () => {
  const f = fixture(0);
  const start = f.service.commands.addProperty(f.database.id,{name:"Start",type:"date"});
  const end = f.service.commands.addProperty(f.database.id,{name:"End",type:"date"});
  const insert = f.db.query("INSERT INTO records (id,database_id,data) VALUES (?,?,?)");
  for (const [id,a,b] of [["cross","2026-10-01","2026-12-01"],["point","2026-11-07",null],["outside","2026-12-07",null],["empty",null,null]]) {
    insert.run(id,f.database.id,JSON.stringify({[start.id]:a,[end.id]:b}));
  }
  const dates = {start:start.id,end:end.id,from:"2026-11-01",to:"2026-11-30"};
  expect(queryRecords(f.db,f.database.id,{dates}).records.map(r=>r.id).sort()).toEqual(["cross","point"]);
  expect(queryRecords(f.db,f.database.id,{dates:{...dates,unscheduled:true}}).records.map(r=>r.id)).toEqual(["empty"]);
});

test('partition counts and pages share sorted results, including null across JSON bridge',async()=>{
 const f=fixture(301);
 const group=f.service.commands.addProperty(f.database.id,{name:'Group',type:'multi_select',config:{options:['A','B']}});
 const date=f.service.commands.addProperty(f.database.id,{name:'Day',type:'date'});
 f.db.query('UPDATE records SET data=json_set(data,?,?,?,?) WHERE id=?').run(`$.${group.id}`,JSON.stringify(['A','B']),`$.${date.id}`,'2026-11-09','rec_00000');
 f.db.query('UPDATE records SET data=json_set(data,?,json(?)) WHERE id=?').run(`$.${group.id}`,JSON.stringify(['A','B']),'rec_00000');
 const queries=createRecordQuerySessions(f.db,()=>1),index=await queries.open(f.database.id,{partitions:{group:group.id,date:date.id}});
 expect(index.partitions['group:"A"']).toBe(1);expect(index.partitions['group:"B"']).toBe(1);
 expect(index.partitions['group:null']).toBe(300);expect(index.partitions['date:2026-11-09']).toBe(1);
 expect(index.partitions['date:scheduled']).toBe(1);
 expect(index.partitions['date:']).toBe(300);
 expect(queries.page(index.id,0,100,'date:scheduled').records.map(r=>r.id)).toEqual(['rec_00000']);
 expect(index.range).toEqual({min:'2026-11-09',max:'2026-11-09'});
 expect(queries.page(index.id,0,100,null as any).records).toHaveLength(100);
 expect(queries.page(index.id,0,3,'date:2026-11-09').records[0]?.id).toBe('rec_00000');
});
test('new generation cancels an outstanding scan for the same page owner',async()=>{
 const f=fixture(1000),queries=createRecordQuerySessions(f.db,()=>1);
 const first=queries.open(f.database.id,{owner:'page',search:'else'});
 const rejected=first.then(()=>'resolved',e=>e.message);
 const next=queries.open(f.database.id,{owner:'page'});
 expect(await rejected).toContain('cancelled');expect((await next).total).toBe(1000);
 const closing=queries.open(f.database.id,{owner:'close'});queries.close('owner:close');await expect(closing).rejects.toThrow('cancelled');
});

test('v2 default query returns cursor pages without materializing the whole ID index',async()=>{
 const f=fixture(401);f.db.query("UPDATE records SET order_key=NULL WHERE id >= 'rec_00200'").run();
 let revision=1;const reads:string[]=[];
 const driver={query(sql:string){reads.push(sql);return f.db.query(sql);},exec:f.db.exec.bind(f.db),transaction:f.db.transaction.bind(f.db)};
 const sessions=createRecordQuerySessions(driver,()=>revision);
 const opened=await sessions.open(f.database.id,{protocol:2});
 expect(opened.id.startsWith('cursor_')).toBe(true);
 expect(reads.some(sql=>sql.includes(' AS data'))).toBe(false);
 const expected=queryRecords(f.db,f.database.id,{limit:200}).records;
 const first=sessions.page(opened.id,0,100),second=sessions.page(opened.id,100,100);
 expect([...first.records,...second.records]).toEqual(expected);
 expect(reads.filter(sql=>sql.includes('OFFSET'))).toHaveLength(0);
 const distant=sessions.page(opened.id,300,100);
 expect(distant.records).toEqual(queryRecords(f.db,f.database.id,{offset:300,limit:100}).records);
 expect(sessions.locate(opened.id,distant.records[0]!.id)).toBe(300);
 revision++;expect(()=>sessions.page(opened.id)).toThrow('stale');
});

test('v2 filtered sessions publish first page before full statistics, then converge',async()=>{
 const f=fixture(2000);const sessions=createRecordQuerySessions(f.db,()=>1);
 const query={protocol:2 as const,filter:{op:'and' as const,rules:[{id:'filter',prop:f.n.id,cond:'ge' as const,value:0}]}};
 const opened=await sessions.open(f.database.id,query);
 expect(opened.id.startsWith('stream_')).toBe(true);
 expect((opened as any).statistics).toBe('loading');
 expect(sessions.page(opened.id,0,100).records).toHaveLength(100);
 let status=sessions.status(opened.id);
 while(status.statistics==='loading'){await Bun.sleep(1);status=sessions.status(opened.id);}
 const expected=queryRecords(f.db,f.database.id,query);
 expect(status.total).toBe(expected.total);
 expect(sessions.page(opened.id,0,60).records).toEqual(expected.records);
 sessions.close(opened.id);expect(()=>sessions.status(opened.id)).toThrow('stale');
});
test('closing then reusing an owner cannot revive the cancelled generation',async()=>{
 const f=fixture(1000),sessions=createRecordQuerySessions(f.db,()=>1);
 const pending=sessions.open(f.database.id,{owner:'same',protocol:2,search:'else'});
 const result=pending.then(()=>false,e=>e.message.includes('cancelled'));
 sessions.close('owner:same');
 const next=await sessions.open(f.database.id,{owner:'same',protocol:2,sort:[{prop:f.n.id,desc:true}]});
 expect(await result).toBe(true);expect(next.total).toBe(1000);
 sessions.clear();expect(()=>sessions.page(next.id)).toThrow('stale');
});
test('field-only sorts project required cells but retain legacy filter and full-page semantics',async()=>{
 const f=fixture(600),reads:string[]=[];
 const driver={query(sql:string){reads.push(sql);return f.db.query(sql);},exec:f.db.exec.bind(f.db),transaction:f.db.transaction.bind(f.db)};
 const query={protocol:2 as const,filter:{op:'and' as const,rules:[{id:'n',prop:f.n.id,cond:'ge',value:3}]},sort:[{prop:f.n.id,desc:true}]};
 const sessions=createRecordQuerySessions(driver,()=>1),index=await sessions.open(f.database.id,query);
 expect(reads.some(sql=>sql.includes('json_object')&&sql.includes('LIMIT 200'))).toBe(true);
 expect(sessions.page(index.id,0,60).records).toEqual(queryRecords(f.db,f.database.id,query).records);
});
