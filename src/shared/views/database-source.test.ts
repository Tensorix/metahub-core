import {expect,test} from 'bun:test';
import {DatabaseQueryWindow,type DatabaseDataSource} from './database-source';
function source():DatabaseDataSource {
 return {openRecordQuery:async()=>({id:'q',revision:1,total:50000,calc:{},partitions:{'group:"A"':1200},range:{min:null,max:null}}),readRecordQuery:async(_id,offset=0,limit=100)=>({records:Array.from({length:limit},(_,i)=>({id:String(offset+i),database_id:'db',cells:{t:offset+i},values:{}})),offset,limit,total:50000,hasMore:true,calc:{}}),locateRecordQuery:async(_id,id)=>Number(id),closeRecordQuery:async()=>{}};
}
test('50k scrolling evicts bodies above 1000 and preserves absolute row coordinates',async()=>{
 const window=new DatabaseQueryWindow(source(),()=>{},e=>{throw e;});await window.open('db',{});
 for(let offset=0;offset<50000;offset+=1000)await window.ensure(offset,offset+300);
 const rows=window.rows();expect(rows.length).toBe(50000);expect(rows.filter(Boolean).length).toBeLessThanOrEqual(1000);expect(rows[49200]?.id).toBe('49200');expect(rows[0]).toBeUndefined();
 await window.ensure(0,100);expect(window.rows()[0]?.id).toBe('0');await window.dispose();
});
test('late page responses cannot leak into a newer query',async()=>{
 const api=source();let release:(value:any)=>void=()=>{};
 api.readRecordQuery=()=>new Promise(resolve=>{release=resolve;});
 const window=new DatabaseQueryWindow(api,()=>{},e=>{throw e;});await window.open('db',{});
 const pending=window.ensure(0,100);await window.open('db',{search:'changed'});
 release({records:[{id:'old',database_id:'db',cells:{},values:{}}]});await pending;
 expect(window.rows().filter(Boolean)).toHaveLength(0);
});
