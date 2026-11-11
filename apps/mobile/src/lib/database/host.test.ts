import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {initSchema} from '../../../../../src/core/schema-init';
import {createReplicaService} from '../../../../../src/core/replica/service';
import {createDatabaseHost} from './host';
function fixture(){const db=new Database(':memory:');initSchema(db);const service=createReplicaService(db);const database=service.commands.createDatabase({name:'test'});const prop=service.commands.addProperty(database.id,{name:'Title',type:'text'});const row=service.commands.createRecord(database.id,{[prop.id]:'Before'});let current=true;const host=createDatabaseHost(service,database.id,()=>current,{openRecord:()=>{},clipboardRead:async()=>'',clipboardWrite:async()=>{}});return{db,service,database,prop,row,host,leave:()=>{current=false;}};}
test('draft ACK is persistent, revisions cannot overwrite new input, flush shares native writer',async()=>{
 const f=fixture();try{
  expect(await f.host.call('checkpoint',[f.row.id,f.prop.id,'你好',2])).toEqual({revision:2});
  await f.host.call('checkpoint',[f.row.id,f.prop.id,'old',1]);
  expect(f.service.drafts.readFields(f.row.id)[f.prop.id]?.value).toBe('你好');
  await f.host.flush();expect(f.service.commands.getRecord(f.row.id).cells[f.prop.id]).toBe('你好');
  f.leave();await expect(f.host.call('checkpoint',[f.row.id,f.prop.id,'wrong',3])).rejects.toThrow('工作区');
 }finally{f.service.dispose();f.db.close();}
});
test('host overlays restored drafts on bounded pages and persists device preferences',async()=>{
 const f=fixture();try{
  f.service.drafts.checkpointField(f.row.id,f.prop.id,{value:'恢复内容',status:'draft'});
  const index=await f.host.call('openRecordQuery',[f.database.id,{}]) as {id:string};
  const page=await f.host.call('readRecordQuery',[index.id,0,100,null]) as any;
  expect(page.records[0].cells[f.prop.id]).toBe('恢复内容');
  await f.host.call('preference',['mh.db.view.'+f.database.id,'board']);
  expect(f.host.preferences()['mh.db.view.'+f.database.id]).toBe('board');
  await expect(f.host.call('eval',['arbitrary'])).rejects.toThrow('暂不支持');
 }finally{f.service.dispose();f.db.close();}
});
