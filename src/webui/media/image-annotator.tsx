/** @jsxImportSource preact */
// Lightweight image annotator: rectangle, arrow, and text on a canvas overlay.
// Annotations are flattened onto the image (composited at natural resolution and
// exported as a PNG blob) — there's no re-editable vector layer, keeping the doc
// model plain (see plan: "扁平烧录"). Shapes are tracked in display coordinates and
// scaled up on export.
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import { promptDialog } from "../ui.tsx";

type Tool = "rect" | "arrow" | "text";
interface Shape {
  tool: Tool;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  text?: string;
}

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111827", "#ffffff"];
const BASE_LINE = 3;
const BASE_FONT = 20;

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, scale: number) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = BASE_LINE * scale;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (s.tool === "rect") {
    const x = Math.min(s.x1, s.x2) * scale;
    const y = Math.min(s.y1, s.y2) * scale;
    ctx.strokeRect(x, y, Math.abs(s.x2 - s.x1) * scale, Math.abs(s.y2 - s.y1) * scale);
  } else if (s.tool === "arrow") {
    const x1 = s.x1 * scale, y1 = s.y1 * scale, x2 = s.x2 * scale, y2 = s.y2 * scale;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(10, BASE_LINE * scale * 3.2);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (s.tool === "text" && s.text) {
    ctx.font = `600 ${BASE_FONT * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "top";
    // Subtle dark halo so light text stays readable on any background.
    ctx.lineWidth = Math.max(2, BASE_LINE * scale);
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.strokeText(s.text, s.x1 * scale, s.y1 * scale);
    ctx.fillText(s.text, s.x1 * scale, s.y1 * scale);
  }
}

export function ImageAnnotator({
  src,
  onCancel,
  onSave,
}: {
  src: string;
  onCancel: () => void;
  onSave: (blob: Blob) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [color, setColor] = useState(COLORS[0]!);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [busy, setBusy] = useState(false);
  const draft = useRef<Shape | null>(null);
  const drawing = useRef(false);

  const sizeCanvas = () => {
    const img = imgRef.current, cv = canvasRef.current;
    if (!img || !cv) return;
    cv.width = img.clientWidth;
    cv.height = img.clientHeight;
    redraw();
  };

  const redraw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const s of shapes) drawShape(ctx, s, 1);
    if (draft.current) drawShape(ctx, draft.current, 1);
  };
  useEffect(redraw, [shapes]);
  useEffect(() => {
    const onResize = () => sizeCanvas();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const pos = (e: MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = async (e: MouseEvent) => {
    e.preventDefault();
    const p = pos(e);
    if (tool === "text") {
      const text = await promptDialog({ title: "添加文字标注", placeholder: "输入文字…", confirmLabel: "添加" });
      if (text && text.trim()) setShapes((s) => [...s, { tool: "text", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, text: text.trim() }]);
      return;
    }
    drawing.current = true;
    draft.current = { tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color };
    redraw();
  };
  const onMove = (e: MouseEvent) => {
    if (!drawing.current || !draft.current) return;
    const p = pos(e);
    draft.current = { ...draft.current, x2: p.x, y2: p.y };
    redraw();
  };
  const onUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const d = draft.current;
    draft.current = null;
    if (d && (Math.abs(d.x2 - d.x1) > 3 || Math.abs(d.y2 - d.y1) > 3)) setShapes((s) => [...s, d]);
    else redraw();
  };

  const save = () => {
    const img = imgRef.current;
    if (!img) return;
    setBusy(true);
    const out = document.createElement("canvas");
    out.width = img.naturalWidth || img.clientWidth;
    out.height = img.naturalHeight || img.clientHeight;
    const ctx = out.getContext("2d");
    if (!ctx) { setBusy(false); return; }
    ctx.drawImage(img, 0, 0, out.width, out.height);
    const scale = out.width / (canvasRef.current?.width || img.clientWidth || 1);
    for (const s of shapes) drawShape(ctx, s, scale);
    out.toBlob((blob) => {
      setBusy(false);
      if (blob) onSave(blob);
    }, "image/png");
  };

  return (
    <div class="annot" onMouseDown={(e) => e.stopPropagation()}>
      <div class="annot-toolbar">
        <div class="annot-tools">
          <button class={"annot-tool" + (tool === "rect" ? " on" : "")} title="矩形框选" onClick={() => setTool("rect")}><Icon name="square" cls="ico sm" /></button>
          <button class={"annot-tool" + (tool === "arrow" ? " on" : "")} title="箭头" onClick={() => setTool("arrow")}><Icon name="arrowUpRight" cls="ico sm" /></button>
          <button class={"annot-tool" + (tool === "text" ? " on" : "")} title="文字" onClick={() => setTool("text")}><Icon name="type" cls="ico sm" /></button>
        </div>
        <div class="annot-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              class={"annot-swatch" + (c === color ? " on" : "")}
              style={{ background: c }}
              title={c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div class="annot-actions">
          <button class="annot-tool" title="撤销" disabled={!shapes.length} onClick={() => setShapes((s) => s.slice(0, -1))}><Icon name="undo" cls="ico sm" /></button>
          <button class="btn btn-secondary" onClick={onCancel}>取消</button>
          <button class="btn btn-primary" disabled={busy} onClick={save}>{busy ? "保存中…" : "保存"}</button>
        </div>
      </div>
      <div class="annot-stage">
        <div class="annot-img-wrap">
          <img ref={imgRef} src={src} alt="" draggable={false} onLoad={sizeCanvas} />
          <canvas
            ref={canvasRef}
            class={"annot-canvas tool-" + tool}
            onMouseDown={(e) => void onDown(e as MouseEvent)}
            onMouseMove={(e) => onMove(e as MouseEvent)}
            onMouseUp={onUp}
            onMouseLeave={onUp}
          />
        </div>
      </div>
    </div>
  );
}
