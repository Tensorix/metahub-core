/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useLayoutEffect, useRef } from "preact/hooks";

/** Escape the table's overflow-x scrollport, which also clips vertical overflow.
 *  Keep the display cell in flow so editing never changes the row height. */
export function GridCellEditor({ children, cell: getCell, recordId, propId }: { children: ComponentChildren; cell?:()=>HTMLElement|null; recordId?:string;propId?:string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const cell = getCell?.() ?? anchor.current!.closest("td")!;
    if(!cell)return;
    let lastRect=cell.getBoundingClientRect();
    const el = editor.current!;
    el.dataset.recordId = recordId ?? cell.closest<HTMLElement>("tr[data-row-id]")?.dataset.rowId;
    el.dataset.propId = propId ?? cell.dataset.propId;
    const position = () => {
      const rect = cell.isConnected ? (lastRect=cell.getBoundingClientRect()) : lastRect;
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const gap = 4;
      const availableHeight = Math.max(0, height - gap * 2);
      const desiredWidth=window.matchMedia("(pointer: coarse)").matches ? Math.max(rect.width,300) : rect.width;
      const editorWidth = Math.min(desiredWidth, Math.max(0, width - gap * 2));
      el.style.width = `${editorWidth}px`;
      el.style.minHeight = `${Math.min(rect.height, availableHeight)}px`;
      el.style.maxHeight = `${availableHeight}px`;
      el.style.setProperty("--cell-editor-max-height", `${availableHeight}px`);
      el.style.left = `${Math.max(x + gap, Math.min(rect.left, x + width - editorWidth - gap))}px`;
      el.style.top = `${Math.max(y + gap, Math.min(rect.top, y + height - el.getBoundingClientRect().height - gap))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(cell);
    observer.observe(el);
    // Capture nested scroll containers too; textarea scrolling needs no reanchor.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && el.contains(event.target)) return;
      position();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, []);
  return <>
    <span ref={anchor} hidden />
    {createPortal(<div ref={editor} class="celledit"
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>, document.body)}
  </>;
}
