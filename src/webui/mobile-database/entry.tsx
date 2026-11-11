/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { UiHost } from '../ui';
import { DatabaseView } from '../table';
import { boot, rpc, flush, checkpointReady } from './bridge';
function App() {
  const [requestedView,setRequestedView]=useState(boot.view ?? null);
  useEffect(()=>{const listener=(event:Event)=>setRequestedView((event as CustomEvent).detail);document.addEventListener('database-view-request',listener);return()=>document.removeEventListener('database-view-request',listener);},[]);
  const [db, setDb] = useState<any>(null), [error, setError] = useState('');
  const reload = () => rpc<any[]>('listDatabases').then(rows => { const found = rows.find(r => r.id === boot.databaseId); if (!found) throw new Error('数据表已删除'); setDb(found); }).catch(e => setError(e.message));
  useEffect(()=>{const listener=(e:Event)=>setError((e as CustomEvent).detail);document.addEventListener('mh-database-error',listener);return()=>document.removeEventListener('mh-database-error',listener);},[]);
  useEffect(() => { void reload(); const changed = () => void reload(); document.addEventListener('mh-synced', changed); return () => document.removeEventListener('mh-synced', changed); }, []);
  return <><UiHost />{error && <div role="alert" class="mobile-db-error" onClick={() => { setError(''); void reload(); }}>{error} · 点击重试</div>}{db ? <DatabaseView db={db} rec={null} onRecNav={id => { if(id) void flush().then(()=>rpc('openRecord',id)).catch(e => setError(e.message)); }} tabReq={requestedView as any} onTabReq={() => setRequestedView(null)} onError={setError} host={{flush,openRecord:async id=>{await flush();await rpc('openRecord',id);},pickDate:value=>rpc('pickDate',value),clipboardRead:()=>rpc('clipboardRead'),clipboardWrite:text=>rpc('clipboardWrite',text),discardCheckpoint:async(id,pid)=>{await checkpointReady();return rpc('discardCheckpoint',id,pid);}}} embedded /> : <p>正在打开数据表…</p>}</>;
}
document.documentElement.dataset.resolved = boot.dark ? 'dark' : 'light';
document.body.classList.add('mobile-database');
document.documentElement.dataset.fontScale=String(boot.fontScale ?? 1);
document.documentElement.style.setProperty('--database-font-scale',String(boot.fontScale ?? 1));
Object.defineProperty(navigator, 'clipboard', { value: { writeText: (text: string) => rpc('clipboardWrite',text), readText: () => rpc('clipboardRead') } });
document.addEventListener('click',event=>{
 const link=(event.target as HTMLElement).closest('a');if(!link)return;
 const href=link.getAttribute('href')??'';event.preventDefault();event.stopPropagation();
 const doc=href.match(/^#\/doc\/([^/?]+)/),record=href.match(/^#\/db\/[^/]+\/([^/?]+)/);
 const operation=doc?()=>rpc('openDocument',decodeURIComponent(doc[1]!)):record?()=>rpc('openRecord',decodeURIComponent(record[1]!)):/^https?:/.test(href)?()=>rpc('openLink',href):null;
 if(operation)void flush().then(operation).catch(e=>document.dispatchEvent(new CustomEvent('mh-database-error',{detail:e.message})));
},true);
render(<App />, document.getElementById('app')!);
