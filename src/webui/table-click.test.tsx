/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { api, type Db, type Prop, type Rec } from "./api.ts";
import { DatabaseView } from "./table.tsx";

GlobalRegistrator.register();
const original = {openRecordQuery:api.openRecordQuery,readRecordQuery:api.readRecordQuery,closeRecordQuery:api.closeRecordQuery, listProperties: api.listProperties, listRecords: api.listRecords, listLocalShares: api.listLocalShares };
const db: Db = { id: "db-click", name: "Clicks", icon: null, meta: null, created_hlc: "" };
const props: Prop[] = [{ id: "title", database_id: db.id, name: "Title", type: "text", config: null, position: 0 }];
const records: Rec[] = ["Alpha", "Beta"].map((title, i) => ({
  id: `rec-${i}`, database_id: db.id, cells: { title }, values: { Title: title },
}));
let host: HTMLDivElement;
const cell = (r: number) => host.querySelector<HTMLElement>(`td.cell-td[data-r="${r}"][data-c="0"]`)!;
const editor = () => document.querySelector(".celledit");
const pointer = (target: EventTarget, type: string, extra: PointerEventInit = {}) => {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10, clientY: 10, ...extra }));
};
function clickCell(r: number, shiftKey = false) {
  act(() => { pointer(cell(r), "pointerdown", { shiftKey }); });
  act(() => { pointer(window, "pointerup", { shiftKey }); });
  act(() => { cell(r).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey })); });
}

beforeEach(async () => {
  api.openRecordQuery=async()=>({id:'q',revision:1,total:records.length,calc:{},partitions:{},range:{min:null,max:null}});
  api.readRecordQuery=async(_id,offset=0,limit=100)=>({records:records.slice(offset,offset+limit),total:records.length,offset,limit,hasMore:false,calc:{}});
  api.closeRecordQuery=async()=>{};
  api.listProperties = async () => props;
  api.listRecords = async () => records;
  api.listLocalShares = async () => [];
  localStorage.removeItem(`mh.db.view.${db.id}`);
  host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    render(<DatabaseView db={db} rec={null} onRecNav={() => {}} tabReq={null} onTabReq={() => {}}
      onError={(message) => { throw new Error(message); }} />, host);
  });
  await act(async()=>{await new Promise(r=>setTimeout(r,10));});
});
afterEach(() => {
  act(() => render(null, host));
  host.remove();
  Object.assign(api, original);
});
afterAll(() => GlobalRegistrator.unregister());

test("first click selects, a later click on the selected cell opens its editor", () => {
  clickCell(0);
  expect(cell(0).classList.contains("cellsel")).toBe(true);
  expect(editor()).toBeNull();
  clickCell(0);
  expect(editor()).not.toBeNull();
  expect(document.activeElement?.closest(".celledit")).not.toBeNull();
});

test("clicking a different cell selects it without editing", () => {
  clickCell(0);
  clickCell(1);
  expect(cell(0).classList.contains("cellsel")).toBe(false);
  expect(cell(1).classList.contains("cellsel")).toBe(true);
  expect(editor()).toBeNull();
  clickCell(1);
  expect(editor()).not.toBeNull();
});

test("Shift extends the range and clicking inside it first collapses the selection", () => {
  clickCell(0);
  clickCell(1, true);
  expect(host.querySelectorAll("td.cellsel").length).toBe(2);
  expect(editor()).toBeNull();
  clickCell(1);
  expect(host.querySelectorAll("td.cellsel").length).toBe(1);
  expect(editor()).toBeNull();
  clickCell(1, true);
  expect(editor()).toBeNull();
});

test("dragging or cancelling over a selected cell never opens its editor", () => {
  clickCell(0);
  act(() => { pointer(cell(0), "pointerdown"); });
  act(() => { pointer(window, "pointercancel"); });
  act(() => { cell(0).click(); });
  expect(editor()).toBeNull();
  act(() => { pointer(cell(0), "pointerdown"); });
  const originalHit = document.elementFromPoint;
  document.elementFromPoint = () => cell(1);
  try {
    act(() => { pointer(window, "pointermove", { clientY: 20 }); });
    act(() => { pointer(window, "pointerup", { clientY: 20 }); });
    act(() => { cell(0).click(); });
  } finally { document.elementFromPoint = originalHit; }
  expect(host.querySelectorAll("td.cellsel").length).toBe(2);
  expect(editor()).toBeNull();
});

test('50k row viewport stays bounded and scrolling does not unmount an active editor',async()=>{
 api.openRecordQuery=async()=>({id:'large',revision:1,total:50000,calc:{},partitions:{},range:{min:null,max:null}});
 api.readRecordQuery=async(_id,offset=0,limit=100)=>({records:Array.from({length:limit},(_,i)=>({id:`large-${offset+i}`,database_id:db.id,cells:{title:`Row ${offset+i}`},values:{Title:`Row ${offset+i}`}})),offset,limit,total:50000,hasMore:true,calc:{}});
 await act(async()=>{render(null,host);render(<DatabaseView db={db} rec={null} onRecNav={()=>{}} tabReq={null} onTabReq={()=>{}} onError={message=>{throw new Error(message);}}/>,host);});
 await act(async()=>{await new Promise(r=>setTimeout(r,15));});
 for(let i=0;i<5&&!cell(0);i++)await act(async()=>{await new Promise(r=>setTimeout(r,20));});
 clickCell(0);clickCell(0);const input=editor();expect(input).not.toBeNull();
 const scroller=host.querySelector<HTMLElement>('.tablescroll')!;
 Object.defineProperty(scroller,'clientHeight',{value:500});Object.defineProperty(scroller,'clientWidth',{value:600});
 await act(async()=>{scroller.scrollTop=44*40000;scroller.dispatchEvent(new Event('scroll'));await new Promise(r=>setTimeout(r,15));});
 await act(async()=>{await new Promise(r=>setTimeout(r,20));});
 expect(editor()).toBe(input);expect(host.querySelectorAll('tbody tr').length).toBeLessThan(40);
 expect(host.querySelector('tr[data-row-id="large-40000"]')).not.toBeNull();
});

test('touch tap selects then trailing click opens an editor that survives pointerup',()=>{
 const tap=()=>{act(()=>pointer(cell(0),'pointerdown',{pointerType:'touch'}));act(()=>pointer(window,'pointerup',{pointerType:'touch'}));act(()=>{cell(0).dispatchEvent(new MouseEvent('click',{bubbles:true}));});};
 tap();expect(editor()).toBeNull();tap();expect(editor()).not.toBeNull();expect(document.activeElement?.closest('.celledit')).not.toBeNull();
});

test('failed field save keeps the editor and input available for retry',async()=>{
 const update=api.updateRecord;const messages:string[]=[];
 await act(async()=>render(<DatabaseView db={db} rec={null} onRecNav={()=>{}} tabReq={null} onTabReq={()=>{}} onError={m=>messages.push(m)}/>,host));
 api.updateRecord=async()=>{throw new Error('offline');};
 try{
  clickCell(0);clickCell(0);
  const input=document.querySelector<HTMLTextAreaElement>('.celledit textarea')!;
  input.value='尚未保存的中文';
  await act(async()=>{input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,30));});
  expect(editor()).not.toBeNull();expect(input.value).toBe('尚未保存的中文');
  expect(editor()?.textContent).toContain('重试');expect(messages.length).toBeGreaterThan(0);
 }finally{api.updateRecord=update;}
});
