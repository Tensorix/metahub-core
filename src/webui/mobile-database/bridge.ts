export const boot = (window as any).__METAHUB_DATABASE__ as { session: string; workspace: string; databaseId: string; view?: string; dark: boolean; fontScale?: number };
let sequence = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
export function rpc<T = any>(method: string, ...args: unknown[]): Promise<T> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请重试')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    (window as any).ReactNativeWebView.postMessage(JSON.stringify({ v: 1, session: boot.session, workspace: boot.workspace, id, method, args }));
  });
}
(window as any).__metahubDatabaseReceive = (message: any) => {
  if (message.session !== boot.session) return;
  if (message.type === 'flush') {
    if(message.navigation){
      const dialog=document.querySelector<HTMLDialogElement>('dialog[open]');
      if(dialog){dialog.dispatchEvent(new Event('cancel'));void rpc('flushed',message.token,null,true);return;}
      if(document.querySelector('.menu-layer,.modal-scrim.open')){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));void rpc('flushed',message.token,null,true);return;}
    }
    void flush().then(() => rpc('flushed', message.token, null), e => rpc('flushed', message.token, e.message)); return; }
  if(message.type==='view'){document.dispatchEvent(new CustomEvent('database-view-request',{detail:message.view}));return;}
  if (message.type === 'freeze') { document.body.inert = message.value; return; }
  if (message.type === 'changed') { document.dispatchEvent(new CustomEvent('mh-synced', { detail: message.change })); return; }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  clearTimeout(waiter.timer); pending.delete(message.id);
  message.ok ? waiter.resolve(message.value) : waiter.reject(new Error(message.error));
};

let draftRevision=0;
let checkpoint: Promise<unknown> = Promise.resolve();
let checkpointError: Error | null = null;
let lastPayload:unknown[]|null=null;
document.addEventListener('input', event => {
 const input=event.target as HTMLInputElement;
 const cell=input.closest<HTMLElement>('[data-prop-id]'),row=input.closest<HTMLElement>('[data-record-id],tr[data-row-id]');
 if(!cell || !row || input.type === 'checkbox')return;
 const value=input.isContentEditable ? input.textContent : input.value;
 const revision=++draftRevision;
 document.dispatchEvent(new CustomEvent('database-draft-status',{detail:'正在保留草稿…'}));
 const payload=lastPayload=[row.dataset.recordId ?? row.dataset.rowId,cell.dataset.propId,value,revision];
 checkpoint=checkpoint.catch(()=>{}).then(()=>rpc('checkpoint',...payload)).then(()=>{checkpointError=null;if(revision===draftRevision)document.dispatchEvent(new CustomEvent('database-draft-status',{detail:'草稿已保留'}));},e=>{checkpointError=e;document.dispatchEvent(new CustomEvent('database-draft-status',{detail:'草稿未确认保留，请重试'}));});
},true);
export async function checkpointReady(){await checkpoint;if(checkpointError && lastPayload){await rpc('checkpoint',...lastPayload);checkpointError=null;document.dispatchEvent(new CustomEvent('database-draft-status',{detail:'草稿已保留'}));}if(checkpointError)throw checkpointError;}
window.addEventListener('mh-preference',((e:CustomEvent)=>{void rpc('preference',e.detail.key,e.detail.value).catch(error=>document.dispatchEvent(new CustomEvent('mh-database-error',{detail:error.message})));}) as EventListener);
export async function flush() {
 if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
 await new Promise(resolve=>setTimeout(resolve,0));
 await checkpointReady();
 const deadline=Date.now()+10000;
 while(pending.size) { if(Date.now()>deadline)throw new Error('保存仍在进行，请重试'); await new Promise(resolve=>setTimeout(resolve,10)); }
 await rpc('flush');
}
