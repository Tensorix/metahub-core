/** @jsxImportSource preact */
// Lightweight image annotator: rectangle, arrow, and text on a canvas overlay.
// Annotations are flattened onto the image (composited at natural resolution and
// exported as a PNG blob) — there's no re-editable vector layer, keeping the doc
// model plain (see plan: "扁平烧录"). Shapes are tracked in display coordinates and
// scaled up on export; the on-screen canvas renders at devicePixelRatio so
// strokes stay crisp on retina displays.
//
// In edit mode the annotator owns the single toolbar row (filename · tools ·
// colors · undo/redo · cancel/save · close) — the viewer's own toolbar is not
// rendered, so the chrome never stacks two rows.
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons.tsx";

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
const LINE_H = 1.3; // text line-height factor (canvas and overlay input agree)
const TEXT_FONT = (px: number) => `600 ${px}px system-ui, -apple-system, sans-serif`;

const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: "rect", icon: "annotRect", label: "矩形框选" },
  { id: "arrow", icon: "annotArrow", label: "箭头" },
  { id: "text", icon: "annotText", label: "文字" },
];

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
    const len = Math.hypot(x2 - x1, y2 - y1);
    // Dart-shaped head, sized off the stroke; the shaft stops inside the head
    // so the rounded cap never pokes past the sharp tip.
    const head = Math.min(Math.max(13, BASE_LINE * scale * 4.5), Math.max(len, 1));
    const bx = x2 - head * 0.7 * Math.cos(ang);
    const by = y2 - head * 0.7 * Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x2 - head * 0.78 * Math.cos(ang), y2 - head * 0.78 * Math.sin(ang));
    ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  } else if (s.tool === "text" && s.text) {
    ctx.font = TEXT_FONT(BASE_FONT * scale);
    ctx.textBaseline = "top";
    // Subtle dark halo so light text stays readable on any background.
    ctx.lineWidth = Math.max(2, BASE_LINE * scale);
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    const lh = BASE_FONT * LINE_H * scale;
    s.text.split("\n").forEach((line, i) => {
      ctx.strokeText(line, s.x1 * scale, s.y1 * scale + i * lh);
      ctx.fillText(line, s.x1 * scale, s.y1 * scale + i * lh);
    });
  }
}

/** Position + payload of the inline text overlay. `editIndex` points at the
 *  shape being re-edited (it is skipped during redraw), null = new text. */
interface TextEdit {
  x: number;
  y: number;
  editIndex: number | null;
  initial: string;
}

export function ImageAnnotator({
  src,
  name,
  draggableBar,
  onCancel,
  onClose,
  onSave,
}: {
  src: string;
  name?: string;
  /** In the frameless desktop window, make the toolbar an OS drag region. */
  draggableBar?: boolean;
  /** Leave edit mode (back to the preview). */
  onCancel: () => void;
  /** Close the whole viewer / preview window. */
  onClose?: () => void;
  onSave: (blob: Blob) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [color, setColor] = useState(COLORS[0]!);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [redoStack, setRedoStack] = useState<Shape[]>([]);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const draft = useRef<Shape | null>(null);
  const drawing = useRef(false);
  // Ref mirror so blur + Escape (which fire before re-render) can't double-commit.
  const textEditRef = useRef<TextEdit | null>(null);
  const openText = (te: TextEdit | null) => { textEditRef.current = te; setTextEdit(te); };

  const sizeCanvas = () => {
    const img = imgRef.current, cv = canvasRef.current;
    if (!img || !cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(img.clientWidth * dpr);
    cv.height = Math.round(img.clientHeight * dpr);
    redraw();
  };

  const redraw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // shapes stay in display px
    const skip = textEditRef.current?.editIndex;
    shapes.forEach((s, i) => { if (i !== skip) drawShape(ctx, s, 1); });
    if (draft.current) drawShape(ctx, draft.current, 1);
  };
  useEffect(redraw, [shapes, textEdit]);
  useEffect(() => {
    const onResize = () => sizeCanvas();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const pos = (e: PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ---- undo / redo ----
  const pushShape = (s: Shape) => { setShapes((prev) => [...prev, s]); setRedoStack([]); };
  const undo = () => {
    if (textEditRef.current || !shapes.length) return;
    setRedoStack((r) => [...r, shapes[shapes.length - 1]!]);
    setShapes(shapes.slice(0, -1));
  };
  const redo = () => {
    if (textEditRef.current || !redoStack.length) return;
    setShapes([...shapes, redoStack[redoStack.length - 1]!]);
    setRedoStack(redoStack.slice(0, -1));
  };

  // ---- inline text overlay ----
  const measureText = (ctx: CanvasRenderingContext2D, text: string) => {
    ctx.font = TEXT_FONT(BASE_FONT);
    let w = 0;
    const lines = text.split("\n");
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    return { w, h: lines.length * BASE_FONT * LINE_H };
  };

  const hitText = (p: { x: number; y: number }) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return -1;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i]!;
      if (s.tool !== "text" || !s.text) continue;
      const { w, h } = measureText(ctx, s.text);
      if (p.x >= s.x1 - 4 && p.x <= s.x1 + w + 4 && p.y >= s.y1 - 4 && p.y <= s.y1 + h + 4) return i;
    }
    return -1;
  };

  const autosizeText = () => {
    const ta = taRef.current;
    if (!ta) return;
    const ctx = canvasRef.current?.getContext("2d");
    const w = ctx ? measureText(ctx, ta.value).w : 0;
    ta.style.width = `${Math.ceil(Math.max(60, w + 14))}px`;
    ta.style.height = "0px";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  /** Close the overlay; returns the resulting shape list synchronously so
   *  save() can composite text that was still being typed. */
  const finishText = (commit: boolean): Shape[] => {
    const te = textEditRef.current;
    if (!te) return shapes;
    const raw = commit ? (taRef.current?.value ?? "") : "";
    openText(null);
    const text = raw.replace(/\s+$/, "");
    let next = shapes;
    if (te.editIndex != null) {
      const cur = shapes[te.editIndex];
      if (cur) {
        if (!text.trim()) next = shapes.filter((_, i) => i !== te.editIndex);
        else if (text !== cur.text || color !== cur.color) {
          next = [...shapes];
          next[te.editIndex] = { ...cur, text, color };
        }
      }
    } else if (text.trim()) {
      next = [...shapes, { tool: "text", x1: te.x, y1: te.y, x2: te.x, y2: te.y, color, text }];
    }
    if (next !== shapes) { setShapes(next); setRedoStack([]); }
    return next;
  };

  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !textEdit) return;
    ta.value = textEdit.initial;
    autosizeText();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [textEdit]);

  // ---- keyboard: undo/redo + escape, fenced off from the editor underneath ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (textEditRef.current) finishText(false);
        else onCancel();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z" || e.key === "y")) {
        // Let the text overlay keep its native input undo.
        if (textEditRef.current && e.target === taRef.current) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "y" || e.shiftKey) redo();
        else undo();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [shapes, redoStack, textEdit, color, onCancel]);

  // ---- pointer drawing ----
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (textEditRef.current) return; // click-away → textarea blur commits; don't also draw
    e.preventDefault();
    const p = pos(e);
    if (tool === "text") {
      const idx = hitText(p);
      if (idx >= 0) {
        const s = shapes[idx]!;
        setColor(s.color);
        openText({ x: s.x1, y: s.y1, editIndex: idx, initial: s.text ?? "" });
      } else {
        openText({ x: p.x, y: p.y, editIndex: null, initial: "" });
      }
      return;
    }
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    draft.current = { tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color };
    redraw();
  };
  const onMove = (e: PointerEvent) => {
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
    if (d && (Math.abs(d.x2 - d.x1) > 3 || Math.abs(d.y2 - d.y1) > 3)) pushShape(d);
    else redraw();
  };

  const save = () => {
    const img = imgRef.current;
    if (!img) return;
    const list = finishText(true); // commit any text still being typed
    setBusy(true);
    const out = document.createElement("canvas");
    out.width = img.naturalWidth || img.clientWidth;
    out.height = img.naturalHeight || img.clientHeight;
    const ctx = out.getContext("2d");
    if (!ctx) { setBusy(false); return; }
    ctx.drawImage(img, 0, 0, out.width, out.height);
    const scale = out.width / (img.clientWidth || 1);
    for (const s of list) drawShape(ctx, s, scale);
    out.toBlob((blob) => {
      setBusy(false);
      if (blob) onSave(blob);
    }, "image/png");
  };

  return (
    <div class="annot" onMouseDown={(e) => e.stopPropagation()}>
      <div class={"lightbox-toolbar annot-bar" + (draggableBar ? " app-drag" : "")}>
        {name && <span class="lightbox-name" title={name}>{name}</span>}
        <span class="lightbox-spacer" />
        <div class="annot-seg" role="group">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              class={"annot-seg-btn" + (tool === t.id ? " on" : "")}
              title={t.label}
              onClick={() => setTool(t.id)}
            >
              <Icon name={t.icon} />
            </button>
          ))}
        </div>
        <span class="annot-div" />
        <div class="annot-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              class={"annot-swatch" + (c === color ? " on" : "")}
              style={{ background: c }}
              title={c}
              onMouseDown={(e) => e.preventDefault() /* keep the text overlay focused: picking a color recolors the pending text */}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <span class="annot-div" />
        <button class="annot-icon-btn" title="撤销 (⌘Z)" disabled={!shapes.length || !!textEdit} onClick={undo}><Icon name="undo" /></button>
        <button class="annot-icon-btn" title="重做 (⇧⌘Z)" disabled={!redoStack.length || !!textEdit} onClick={redo}><Icon name="redo" /></button>
        <div class="annot-actions">
          <button class="btn btn-secondary" onClick={onCancel}>取消</button>
          <button class="btn btn-primary" disabled={busy} onClick={save}>{busy ? "保存中…" : "保存"}</button>
        </div>
        {onClose && <button title="关闭" onClick={onClose}><Icon name="x" /></button>}
      </div>
      <div class="annot-stage">
        <div class="annot-img-wrap">
          <img ref={imgRef} src={src} alt="" draggable={false} onLoad={sizeCanvas} />
          <canvas
            ref={canvasRef}
            class={"annot-canvas tool-" + tool}
            onPointerDown={(e) => onDown(e as PointerEvent)}
            onPointerMove={(e) => onMove(e as PointerEvent)}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          {textEdit && (
            <textarea
              ref={taRef}
              class="annot-text-input"
              style={{ left: `${textEdit.x - 4}px`, top: `${textEdit.y - 5}px`, color }}
              spellcheck={false}
              rows={1}
              onInput={autosizeText}
              onBlur={() => finishText(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishText(true); }
                e.stopPropagation();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
