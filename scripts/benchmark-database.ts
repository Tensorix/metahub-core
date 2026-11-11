/** Host-side repeatable query benchmark. This is not a phone FPS benchmark.
 * bun scripts/benchmark-database.ts */
import { Database } from 'bun:sqlite';
import { initSchema } from '../src/core/schema-init';
import { createReplicaService } from '../src/core/replica/service';
import { createRecordQuerySessions } from '../src/shared/views/query';
const results=[];
for(const count of [10000,50000]) {
 const db=new Database(':memory:');initSchema(db);const service=createReplicaService(db);
 const database=service.commands.createDatabase({name:'Benchmark'});
 const fields=Array.from({length:50},(_,i)=>service.commands.addProperty(database.id,{name:`Field ${i}`,type:i===1?'number':i===2?'select':i===3?'date':'text',...(i===2?{config:{options:['A','B','C']}}:{})}));
 const insert=db.query('INSERT INTO records(id,database_id,order_key,data) VALUES(?,?,?,?)');
 db.transaction(()=>{for(let i=0;i<count;i++)insert.run('r'+String(i).padStart(6,'0'),database.id,String(i).padStart(6,'0'),JSON.stringify(Object.fromEntries(fields.map((p,c)=>[p.id,c===1?i%97:c===2?['A','B','C'][i%3]:c===3?`2026-11-${String(i%28+1).padStart(2,'0')}`:`记录 ${i} 字段 ${c} · 中文内容测试`]))));})();
 const queries=createRecordQuerySessions(db,()=>1);
 const samples=[];
 for(let run=0;run<5;run++) {
  const t=performance.now();const index=await queries.open(database.id,{partitions:{group:fields[2]!.id,date:fields[3]!.id}});const opened=performance.now();const page=queries.page(index.id,0);const first=performance.now();queries.page(index.id,count-100);const last=performance.now();
  const complex=await queries.open(database.id,{search:'中文',sort:[{prop:fields[1]!.id,desc:true}],calc:{[fields[1]!.id]:'sum'}});const end=performance.now();
  samples.push({indexMs:opened-t,firstPageMs:first-opened,lastPageMs:last-first,complexMs:end-last,pageBytes:JSON.stringify(page).length});queries.close(index.id);queries.close(complex.id);
 }
 const p95=(key:'indexMs'|'firstPageMs'|'lastPageMs'|'complexMs')=>Math.round(samples.map(x=>x[key]).sort((a,b)=>a-b)[4]!);
 results.push({rows:count,columns:50,runs:5,indexP95Ms:p95('indexMs'),firstPageP95Ms:p95('firstPageMs'),lastPageP95Ms:p95('lastPageMs'),complexP95Ms:p95('complexMs'),page100KB:Math.round(samples[0]!.pageBytes/1024)});
 service.dispose();db.close();
}
console.log(JSON.stringify({runtime:`Bun ${Bun.version}`,scope:'host SQLite only; not simulator or phone acceptance',results},null,2));
