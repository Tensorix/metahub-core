/** Scroll owns a moving finger; a stationary 350ms press arms editing. */
export function deferTouchDrag(event: PointerEvent, activate: (event: PointerEvent) => void, tap?: () => void): boolean {
 if(event.pointerType!=='touch' || (event as any).__longPress)return false;
 if((event.target as HTMLElement)?.closest('button,a,input,textarea,[contenteditable]'))return false;
 const currentTarget=event.currentTarget;
 let ended=false;
 const cleanup=()=>{clearTimeout(timer);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);};
 const cancel=()=>{ended=true;cleanup();};
 const move=(next:PointerEvent)=>{if(next.pointerId===event.pointerId && Math.hypot(next.clientX-event.clientX,next.clientY-event.clientY)>8)cancel();};
 const up=(next:PointerEvent)=>{if(next.pointerId!==event.pointerId)return;cleanup();if(!ended)tap?.();};
 const timer=setTimeout(()=>{
  if(ended)return;cleanup();
  const block=(e:TouchEvent)=>e.preventDefault();
  const release=()=>{window.removeEventListener('touchmove',block);window.removeEventListener('pointerup',release);window.removeEventListener('pointercancel',release);};
  window.addEventListener('touchmove',block,{passive:false});window.addEventListener('pointerup',release);window.addEventListener('pointercancel',release);
  Object.defineProperty(event,'currentTarget',{value:currentTarget,configurable:true});
  (event as any).__longPress=true;activate(event);
 },350);
 window.addEventListener('pointermove',move,{passive:true});window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);
 return true;
}
