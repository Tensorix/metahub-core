/** @jsxImportSource preact */
// Fullscreen image preview: zoom (buttons + wheel, cursor-anchored) and pan
// (drag). The "标注" button swaps in the ImageAnnotator; saving there hands a
// flattened PNG back to onReplace (the editor uploads it and swaps the block src).
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import { ImageAnnotator } from "./image-annotator.tsx";

const MIN = 0.2;
const MAX = 8;

export function ImageLightbox({
  src,
  name,
  onClose,
  onReplace,
}: {
  src: string;
  name?: string;
  onClose: () => void;
  onReplace: (blob: Blob) => void;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [editing, setEditing] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const reset = () => { setScale(1); setTx(0); setTy(0); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); editing ? setEditing(false) : onClose(); }
      else if ((e.key === "+" || e.key === "=") && !editing) setScale((s) => Math.min(MAX, s * 1.2));
      else if (e.key === "-" && !editing) setScale((s) => Math.max(MIN, s / 1.2));
      else if (e.key === "0" && !editing) reset();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, onClose]);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = stageRef.current?.getBoundingClientRect();
    const cx = rect ? e.clientX - rect.left - rect.width / 2 : 0;
    const cy = rect ? e.clientY - rect.top - rect.height / 2 : 0;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setScale((s) => {
      const ns = Math.max(MIN, Math.min(MAX, s * factor));
      const r = ns / s;
      // keep the point under the cursor fixed while scaling
      setTx((x) => cx - (cx - x) * r);
      setTy((y) => cy - (cy - y) * r);
      return ns;
    });
  };

  const onDown = (e: MouseEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, tx, ty };
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      setTx(d.tx + (e.clientX - d.x));
      setTy(d.ty + (e.clientY - d.y));
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  return (
    <div class="lightbox" onMouseDown={() => onClose()}>
      <div class="lightbox-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        {name && <span class="lightbox-name" title={name}>{name}</span>}
        <span class="lightbox-spacer" />
        {!editing && (
          <>
            <button title="缩小" onClick={() => setScale((s) => Math.max(MIN, s / 1.2))}><Icon name="zoomOut" cls="ico sm" /></button>
            <button class="lightbox-pct" title="重置" onClick={reset}>{Math.round(scale * 100)}%</button>
            <button title="放大" onClick={() => setScale((s) => Math.min(MAX, s * 1.2))}><Icon name="zoomIn" cls="ico sm" /></button>
            <button title="标注 / 编辑" onClick={() => { reset(); setEditing(true); }}><Icon name="pencil" cls="ico sm" /></button>
          </>
        )}
        <button title="关闭" onClick={() => (editing ? setEditing(false) : onClose())}><Icon name="x" cls="ico sm" /></button>
      </div>

      {editing ? (
        <ImageAnnotator src={src} onCancel={() => setEditing(false)} onSave={(b) => { onReplace(b); setEditing(false); }} />
      ) : (
        <div
          ref={stageRef}
          class="lightbox-stage"
          onMouseDown={(e) => { e.stopPropagation(); onDown(e as MouseEvent); }}
          onWheel={(e) => onWheel(e as WheelEvent)}
        >
          <img
            src={src}
            alt={name ?? ""}
            draggable={false}
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, cursor: scale > 1 ? "grab" : "default" }}
          />
        </div>
      )}
    </div>
  );
}
