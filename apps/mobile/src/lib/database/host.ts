import type { ReplicaService } from '../../../../../src/core/replica/service';
import { recordWriter, prepareCell, withRecordDrafts } from '../database-drafts';
export function createDatabaseHost(service: ReplicaService, databaseId: string, current: () => boolean, capabilities: { openRecord(id: string): void; clipboardWrite(text: string): Promise<void>; clipboardRead(): Promise<string>; openDocument?(id:string):void;openLink?(url:string):Promise<unknown> }) {
 const allowed = new Set(['listDatabases','listProperties','listRecords','getRecord','createRecord','updateRecord','deleteRecord','moveRecord','createProperty','updateProperty','deleteProperty','renameSelectOption','removeSelectOption','updateDatabase','listDocuments','createDocument','referenceSummaries','openRecordQuery','readRecordQuery','closeRecordQuery','locateRecordQuery','moveProperty','moveSelectOption','recordHistory','recordAt','recordFieldHistory','revertRecord','auditList','auditRevert']);
 const touched = new Set<string>();
 const revisions=new Map<string,number>();
 const knownRecords=new Set<string>();
 const preferencePrefix=`database:${databaseId}:`;
 const overlay=(row:any)=>{knownRecords.add(row.id);recordWriter(service,row.id);return withRecordDrafts(service,row);};
 const flush = async () => { const props = await service.client.listProperties(databaseId); for(const id of touched) { const result = await recordWriter(service,id).drafts.flush((pid,value) => prepareCell(props,pid,value)); if(!result.ok) throw new Error(result.error); } };
 return { flush, preferences:()=>service.drafts.readPreferences(preferencePrefix), async call(method: string, args: unknown[]) {
  if(!current()) throw new Error('工作区已切换');
  if(method==='preference'){if(typeof args[0]!=='string' || args[0].length>200 || (args[1]!==null && typeof args[1]!=='string'))throw new Error('Invalid preference');service.drafts.setPreference(preferencePrefix+args[0],args[1] as string|null);return null;}
  if(method === 'flush') { await flush(); return null; }
  if(method === 'checkpoint') {
   const id=String(args[0]),pid=String(args[1]),revision=args[3],key=id+':'+pid;
   if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1)throw new Error('Invalid draft revision');
   if(revision<=(revisions.get(key)??0))return {revision:revisions.get(key)};
   if(!knownRecords.has(id)){const row=await service.client.getRecord(id);if(row.database_id!==databaseId)throw new Error('记录不属于当前数据表');knownRecords.add(id);}
   // Preserve recovery text even if a concurrent sync deleted the field/record.
   if(!current())throw new Error('工作区已切换');
   touched.add(id);recordWriter(service,id).drafts.stage(pid,args[2]);
   const saved=service.drafts.readFields(id)[pid];
   if(!saved || JSON.stringify(saved.value)!==JSON.stringify(args[2]))throw new Error('草稿尚未持久化，请重试');
   revisions.set(key,revision);return {revision};
  }
  if(method==='discardCheckpoint') {const id=String(args[0]),pid=String(args[1]),drafts=recordWriter(service,id).drafts;const draft=drafts.fields.get(pid);if(draft){service.drafts.acknowledgeField(id,pid,draft.value);drafts.fields.delete(pid);}return null;}
  if(method==='openDocument'){await flush();capabilities.openDocument?.(String(args[0]));return null;}
  if(method==='openLink'){const url=String(args[0]);if(!/^https?:\/\//.test(url))throw new Error('不支持此链接');await flush();await capabilities.openLink?.(url);return null;}
  if(method === 'clipboardWrite') { if(typeof args[0] !== 'string') throw new Error('Invalid clipboard'); return capabilities.clipboardWrite(args[0]); }
  if(method === 'clipboardRead') return capabilities.clipboardRead();
  if(method === 'openRecord') { await flush(); if(typeof args[0] !== 'string') throw new Error('Invalid record'); await service.client.getRecord(args[0]); capabilities.openRecord(args[0]); return null; }
  if(method === 'listShares' || method === 'listLocalShares') return [];
  if(method === 'setColumnWidth') { method='updateProperty'; args=[args[0],{config:{width:args[1]}}]; }
  if(!allowed.has(method)) throw new Error(`此操作暂不支持：${method}`);
  if(['updateRecord','deleteRecord','moveRecord'].includes(method)) { const row=await service.client.getRecord(String(args[0])); if(row.database_id!==databaseId) throw new Error('记录不属于当前数据表'); }
  if(['updateProperty','deleteProperty','renameSelectOption','removeSelectOption','moveProperty','moveSelectOption'].includes(method)) { const props=await service.client.listProperties(databaseId); if(!props.some(p=>p.id===args[0])) throw new Error('字段不属于当前数据表'); }
  if(method==='updateDatabase' && args[0]!==databaseId) throw new Error('数据表不匹配');
  if(method==='createRecord' && args[0]!==databaseId) throw new Error('数据表不匹配');
  if(method==='createProperty' && (args[0] as any)?.db!==databaseId) throw new Error('数据表不匹配');
  if(method==='updateRecord') {
   const id=String(args[0]), patch=args[1];
   if(!patch || typeof patch!=='object' || Array.isArray(patch)) throw new Error('Invalid record patch');
   const props=await service.client.listProperties(databaseId);if(!current())throw new Error('工作区已切换');const drafts=recordWriter(service,id).drafts; touched.add(id);
   for(const [pid,value] of Object.entries(patch)) { if(!props.some(p=>p.id===pid)) throw new Error('字段已删除'); drafts.stage(pid,value); }
   const result=await drafts.flush((pid,value)=>prepareCell(props,pid,value)); if(!result.ok) throw new Error(result.error);
   return withRecordDrafts(service,await service.client.getRecord(id));
  }
  const fn=(service.client as unknown as Record<string,(...args: unknown[])=>Promise<unknown>>)[method];
  if(!fn) throw new Error('Unsupported host method');
  if(!current())throw new Error('工作区已切换');
  const result=await fn(...args);
  if(!current()) throw new Error('工作区已切换');
  if(method==='listRecords') return (result as any[]).map(overlay);
  if(method==='getRecord')return overlay(result);
  if(method==='readRecordQuery'){const page=result as any;return {...page,records:page.records.map(overlay)};}
  return result;
 }};
}
