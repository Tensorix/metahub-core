import { expect, test } from 'bun:test';
import { virtualWindow, virtualColumns } from './virtual-window';
test('50k rows only mount the viewport and overscan, including the final row',()=>{
 const first=virtualWindow(50000,44,0,800);expect(first.end-first.start).toBeLessThan(30);
 const last=virtualWindow(50000,44,49990*44,800);expect(last.end).toBe(50000);expect(last.before+(last.end-last.start)*44+last.after).toBe(50000*44);
});
test('variable columns preserve total width across both virtual spacers',()=>{
 const widths=Array.from({length:50},(_,i)=>100+i*3);const range=virtualColumns(widths,2000,390);
 expect(range.end-range.start).toBeLessThan(8);
 expect(range.before+widths.slice(range.start,range.end).reduce((a,b)=>a+b,0)+range.after).toBe(widths.reduce((a,b)=>a+b,0));
});
