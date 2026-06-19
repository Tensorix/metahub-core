/** @jsxImportSource preact */
// Block-level "void" embeds: image (selectable + resizable + double-click to
// preview), video / audio (native players), a generic file card, and a transient
// "uploading" skeleton. All store their bytes as a content-addressed blob (see
// api.uploadDocBlob) and serialize to plain Markdown via blocks.ts — these
// components are display + local UI only.
//
// Bytes can be missing even for a valid block (cross-device not-yet-synced, peer
// offline, evicted), so each media element falls back to an "unavailable" card on
// load error; retry remounts the element, re-triggering an on-demand resolve.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Block } from "../blocks.ts";
import { Icon } from "../icons.tsx";

/** Human-readable byte size. */
function fmtSize(n?: number): string {
  if (n == null || !isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Shown when a blob's bytes can't be fetched (not yet synced / load failed). */
function Unavailable({ icon, name, onRetry }: { icon: string; name?: string; onRetry: () => void }) {
  return (
    <div class="void-block void-unavailable">
      <Icon name={icon} cls="ico" />
      <span class="vu-meta">
        <span class="vu-name">{name || "媒体"}</span>
        <span class="vu-sub">字节未同步到本设备或加载失败</span>
      </span>
      <button class="vu-retry" onClick={onRetry} onMouseDown={(e) => e.stopPropagation()}>
        <Icon name="history" cls="ico sm" /> 重试
      </button>
    </div>
  );
}

/** Transient placeholder at the insertion point while a file uploads (detailed
 *  percentage lives in the bottom-right upload tray). */
export function UploadingBlock({ block }: { block: Block }) {
  return (
    <div class="void-block void-uploading">
      <Icon name="spinner" cls="ico spin" />
      <span class="vu-name">{block.name || "上传中…"}</span>
      <span class="vu-sub">上传中…</span>
    </div>
  );
}

export function ImageBlock({
  block,
  selected,
  onResize,
  onPreview,
}: {
  block: Block;
  selected: boolean;
  onResize: (width: number | undefined) => void;
  onPreview: () => void;
}) {
  const figRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [w, setW] = useState<number | undefined>(block.width);
  const liveW = useRef<number | undefined>(block.width);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setW(block.width);
    liveW.current = block.width;
  }, [block.width]);
  useEffect(() => setFailed(false), [block.src]); // a new src clears a prior failure

  const startResize = (e: MouseEvent, side: "l" | "r") => {
    e.preventDefault();
    e.stopPropagation(); // don't let the doc start a block-text selection
    const img = imgRef.current;
    if (!img) return;
    const startX = e.clientX;
    const startW = img.offsetWidth;
    const maxW = (figRef.current?.closest(".doc") as HTMLElement | null)?.clientWidth ?? 1200;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const nw = Math.max(60, Math.min(side === "r" ? startW + dx : startW - dx, maxW));
      liveW.current = Math.round(nw);
      setW(liveW.current);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onResize(liveW.current);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (failed) return <Unavailable icon="image" name={block.name} onRetry={() => { setAttempt((a) => a + 1); setFailed(false); }} />;

  return (
    <div
      ref={figRef}
      class={"void-block void-image" + (selected ? " selected" : "")}
      style={{ width: w ? `${w}px` : undefined }}
      onDblClick={onPreview}
    >
      <img
        key={attempt}
        ref={imgRef}
        src={block.src}
        alt={block.name ?? ""}
        loading="lazy"
        draggable={false}
        title="双击预览 / 标注"
        onError={() => setFailed(true)}
      />
      <button class="void-expand" title="预览" onClick={onPreview} onMouseDown={(e) => e.stopPropagation()}>
        <Icon name="maximize" cls="ico sm" />
      </button>
      {selected && (
        <>
          <span class="img-handle h-l" onMouseDown={(e) => startResize(e as MouseEvent, "l")} />
          <span class="img-handle h-r" onMouseDown={(e) => startResize(e as MouseEvent, "r")} />
        </>
      )}
    </div>
  );
}

export function VideoBlock({ block }: { block: Block }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setFailed(false), [block.src]);
  if (failed) return <Unavailable icon="video" name={block.name} onRetry={() => { setAttempt((a) => a + 1); setFailed(false); }} />;
  return (
    <div class="void-block void-media void-video">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video key={attempt} src={block.src} controls preload="metadata" onError={() => setFailed(true)} />
    </div>
  );
}

export function AudioBlock({ block }: { block: Block }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setFailed(false), [block.src]);
  if (failed) return <Unavailable icon="audio" name={block.name} onRetry={() => { setAttempt((a) => a + 1); setFailed(false); }} />;
  return (
    <div class="void-block void-media void-audio">
      {block.name && <div class="void-audio-name">{block.name}</div>}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio key={attempt} src={block.src} controls preload="metadata" onError={() => setFailed(true)} />
    </div>
  );
}

export function FileBlock({ block }: { block: Block }) {
  const name = block.name || "文件";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "";
  return (
    <a
      class="void-block void-file"
      href={block.src}
      download={name}
      target="_blank"
      rel="noreferrer"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span class="file-glyph">
        <Icon name="file" cls="ico" />
        {ext && <span class="file-ext">{ext}</span>}
      </span>
      <span class="file-meta">
        <span class="file-name">{name}</span>
        <span class="file-sub">{fmtSize(block.size) || "下载文件"}</span>
      </span>
      <span class="file-dl"><Icon name="download" cls="ico sm" /></span>
    </a>
  );
}
