/** Fixed-height preview rows and width-prefix columns use identical geometry. */
export function virtualWindow(count: number, size: number, offset: number, viewport: number, overscan = 4) {
 const start=Math.max(0,Math.min(count,Math.floor(Math.max(0,offset)/size)-overscan));
 const end=Math.min(count,Math.max(start,Math.ceil((Math.max(0,offset)+viewport)/size)+overscan));
 return {start,end,before:start*size,after:(count-end)*size};
}
export function virtualColumns(widths: number[], offset: number, viewport: number) {
 const prefix=[0]; for(const width of widths)prefix.push(prefix[prefix.length-1]!+width);
 const lower=(value:number)=>{let lo=0,hi=widths.length;while(lo<hi){const mid=(lo+hi)>>>1;if(prefix[mid+1]!<=value)lo=mid+1;else hi=mid;}return lo;};
 const start=Math.max(0,lower(Math.max(0,offset))-1),end=Math.min(widths.length,lower(offset+viewport)+2);
 return {start,end,before:prefix[start]!,after:prefix[widths.length]!-prefix[end]!};
}
