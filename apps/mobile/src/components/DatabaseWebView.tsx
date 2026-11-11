import { NativeButton } from '@/components/native/NativeButton';
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { parseDate, toISO } from '../../../../src/shared/views/date';
import { useEffect, useMemo, useRef, useState, useId, useCallback } from 'react';
import { AppState, View, Text, Pressable, Alert, Modal, Linking, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight, usePreventRemove } from 'expo-router/react-navigation';
import { registerRecoveryEditor } from '@/lib/editor/recovery-barrier';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useSession } from '@/lib/auth/session';
import { useTheme } from '@/lib/theme';
import { databaseHTML } from '@/lib/database/bundle';
import { createDatabaseHost } from '@/lib/database/host';
import { scriptJSON } from '@/lib/editor/protocol';
export function DatabaseWebView({ databaseId, initialView, deleted = false }: { databaseId: string; initialView?: string; deleted?: boolean }) {
 const {fontScale}=useWindowDimensions();
 const headerHeight=useHeaderHeight(),insets=useSafeAreaInsets();
 const session=useSession(),router=useRouter(),{scheme,tokens}=useTheme(),web=useRef<WebView<unknown>>(null);
 const [generation,setGeneration]=useState(0),[error,setError]=useState('');
 const [dateRequest,setDateRequest]=useState<{value:Date;resolve(value:string|null|undefined):void}|null>(null);
 const dateRef=useRef(dateRequest);useEffect(()=>{dateRef.current=dateRequest;},[dateRequest]);
 const [initialFontScale]=useState(fontScale);
 const [bootstrapView]=useState(initialView);
 const [initialDark]=useState(scheme==='dark');
 const instance=useId();
 const nonce=`${session.id}:${databaseId}:${generation}:${instance}`;
 const host=useMemo(()=>createDatabaseHost(session.replica.service,databaseId,session.isCurrent,{openRecord:id=>router.push(`/record/${id}`),clipboardWrite:async text=>{await Clipboard.setStringAsync(text);},clipboardRead:Clipboard.getStringAsync,openDocument:id=>router.push(`/doc/${id}`),openLink:url=>Linking.openURL(url)}),[session,databaseId,router]);
 const [exitAllowed,setExitAllowed]=useState(false);
 const flushWaiters=useRef(new Map<string,{resolve(result:{ok:boolean;error?:string;dismissed?:boolean}):void;timer:ReturnType<typeof setTimeout>}>());
 const highWater=useRef(0);
 const replies=useRef(new Map<number,Promise<unknown>>());
 useEffect(()=>{replies.current.clear();highWater.current=0;const waiters=flushWaiters.current;return()=>{for(const waiter of waiters.values()){clearTimeout(waiter.timer);waiter.resolve({ok:false,error:'页面已重新加载'});}waiters.clear();dateRef.current?.resolve(undefined);};},[nonce]);
 const send=useCallback((message: unknown)=>web.current?.injectJavaScript(`window.__metahubDatabaseReceive?.(${scriptJSON(message)});true;`),[]);
 useEffect(()=>{if(initialView)send({session:nonce,type:"view",view:initialView});},[initialView,nonce,send]);
 const flushRenderer=useCallback((navigation=false)=>new Promise<{ok:boolean;error?:string;dismissed?:boolean}>(resolve=>{
  const token=`${Date.now()}:${Math.random()}`;
  const timer=setTimeout(()=>{flushWaiters.current.delete(token);resolve({ok:false,error:'保存超时，请重试；未确认的输入仍在当前页面'});},15000);
  flushWaiters.current.set(token,{resolve,timer});send({session:nonce,type:'flush',token,navigation});
 }),[nonce,send]);
 usePreventRemove(!exitAllowed && !deleted,({repeat})=>{void flushRenderer(true).then(result=>{if(result.dismissed)return;if(result.ok){setExitAllowed(true);repeat();}else Alert.alert('修改尚未保存',result.error,[{text:'留下修正',style:'cancel'},{text:'保留草稿离开',onPress:()=>{setExitAllowed(true);repeat();}}]);});});
 useEffect(()=>registerRecoveryEditor(session,()=>({setFrozen:value=>send({session:nonce,type:'freeze',value}),flush:flushRenderer})),[session,nonce,send,flushRenderer]);
 useEffect(()=>session.replica.service.onChange(change=>send({session:nonce,type:'changed',change})),[session,nonce,send]);
 useEffect(()=>{const listener=AppState.addEventListener('change',state=>{if(state!=='active') void flushRenderer().then(result=>{if(!result.ok)setError(result.error ?? '保存失败');});});return()=>listener.remove();},[flushRenderer]);
 const source=useMemo(()=>({html:databaseHTML.replace('__METAHUB_BOOTSTRAP__',()=>scriptJSON({session:nonce,workspace:session.workspaceId,databaseId,view:bootstrapView,dark:initialDark,fontScale:initialFontScale,preferences:host.preferences()})),baseUrl:'about:blank'}),[nonce,session.workspaceId,databaseId,bootstrapView,host,initialDark,initialFontScale]);
 useEffect(()=>{web.current?.injectJavaScript(`document.documentElement.dataset.resolved=${scriptJSON(scheme)};document.documentElement.dataset.fontScale=${scriptJSON(String(fontScale))};document.documentElement.style.setProperty('--database-font-scale',${scriptJSON(String(fontScale))});window.dispatchEvent(new Event('database-presentation'));true;`);},[scheme,fontScale]);
 return <View style={{flex:1,paddingTop:headerHeight,paddingBottom:insets.bottom}}>{error ? <Pressable onPress={()=>{setError('');setGeneration(g=>g+1);}} style={{padding:12}}><Text>{error} · 点击重新加载</Text></Pressable>:null}<WebView ref={web} source={source} style={{flex:1}} originWhitelist={['about:blank']} domStorageEnabled javaScriptEnabled allowFileAccess={false} mixedContentMode="never" setSupportMultipleWindows={false} hideKeyboardAccessoryView keyboardDisplayRequiresUserAction={false} contentInsetAdjustmentBehavior="never" onShouldStartLoadWithRequest={r=>r.url==='about:blank'} onContentProcessDidTerminate={()=>setError('页面进程已停止，已保存草稿可恢复')} onRenderProcessGone={()=>setError('页面进程已停止，已保存草稿可恢复')} onError={()=>setError('数据表加载失败')} onMessage={event=>{
  let message:any;try{message=JSON.parse(event.nativeEvent.data);}catch{return;}
  if(message.v!==1 || message.session!==nonce || message.workspace!==session.workspaceId || !Number.isSafeInteger(message.id) || !Array.isArray(message.args) || typeof message.method!=='string')return;
  if(message.method==='flushed'){const waiter=flushWaiters.current.get(message.args[0]);if(waiter){clearTimeout(waiter.timer);waiter.resolve({ok:!message.args[1],error:message.args[1],dismissed:message.args[2]===true});flushWaiters.current.delete(message.args[0]);}send({session:nonce,id:message.id,ok:true,value:null});return;}
  if(message.method==='pickDate'){
   dateRef.current?.resolve(undefined);
   setDateRequest({value:parseDate(message.args[0])??new Date(),resolve:value=>{send({session:nonce,id:message.id,ok:true,value:value===undefined?{cancelled:true}:{value}});setDateRequest(null);}});return;
  }
  if(message.id<=highWater.current-256){send({session:nonce,id:message.id,ok:false,error:'请求已过期，请刷新后重试'});return;}
  highWater.current=Math.max(highWater.current,message.id);
  let result=replies.current.get(message.id);
  if(!result){result=host.call(message.method,message.args);replies.current.set(message.id,result);while(replies.current.size>256)replies.current.delete(replies.current.keys().next().value!);}
  void result.then(value=>send({session:nonce,id:message.id,ok:true,value}),cause=>send({session:nonce,id:message.id,ok:false,error:String(cause.message)}));
 }}/>
 <Modal visible={!!dateRequest} transparent animationType="slide" onRequestClose={()=>dateRequest?.resolve(undefined)}>
  <View style={{flex:1,justifyContent:'flex-end',backgroundColor:'#0005'}}><View style={{padding:20,paddingBottom:insets.bottom+20,backgroundColor:tokens.bg}}>
   {dateRequest && <DateTimePicker value={dateRequest.value} mode="date" onChange={(_,date)=>{if(date)setDateRequest(r=>r?{...r,value:date}:r);}}/>}
   <View style={{flexDirection:'row',justifyContent:'space-between',paddingTop:20}}>
    <NativeButton variant="text" label="取消" hostStyle={{minWidth:64,minHeight:48}} onPress={()=>dateRequest?.resolve(undefined)}/>
    <NativeButton variant="text" label="清除日期" hostStyle={{minWidth:96,minHeight:48}} onPress={()=>dateRequest?.resolve(null)}/>
    <NativeButton label="完成" hostStyle={{minWidth:64,minHeight:48}} onPress={()=>dateRequest?.resolve(toISO(dateRequest.value))}/>
   </View>
  </View></View>
 </Modal></View>;
}
