import { rpc, checkpointReady } from './bridge';
export const NAV_INVALIDATE = 'mh-nav-invalidate', REC_INVALIDATE = 'mh-rec-invalidate', SHARES_CHANGED = 'mh-shares-changed';
export const notifySharesChanged = () => {};
export const currentToken = () => null;
export const apiUrl = (_: string): string => { throw new Error('请通过原生详情打开此内容'); };
export const authFetch = async (): Promise<Response> => { throw new Error('此页面不提供网络访问'); };
export const MAX_UPLOAD_BYTES = { image: 20e6, video: 200e6, audio: 100e6, file: 200e6 };
export const api: any = new Proxy({}, { get: (_, method) => async (...args: unknown[]) => {if(method==='updateRecord')await checkpointReady();return rpc(String(method), ...args);} });
export const TYPE_META = Object.fromEntries([
 ['text','text','文本'],['number','hash','数字'],['select','select','单选'],['multi_select','multi','多选'],['checkbox','checkbox','复选框'],['date','calendar','日期'],['url','link','链接'],['relation','relation','关联'],['doc','fileText','文档'],
].map(([type,ic,t]) => [type,{ic,t}]));
export class ApiError extends Error { constructor(message: string, public status = 500) { super(message); } }
