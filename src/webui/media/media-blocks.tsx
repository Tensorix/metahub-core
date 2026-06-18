/** @jsxImportSource preact */
// Block-level "void" embeds: image (selectable + resizable + double-click to
// preview), video / audio (native players), and a generic file card. All store
// their bytes as a content-addressed blob (see api.uploadDocBlob) and serialize
// to plain Markdown via blocks.ts — these components are display + local UI only.
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
  useEffect(() => {
    setW(block.width);
    liveW.current = block.width;
  }, [block.width]);

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

  return (
    <div
      ref={figRef}
      class={"void-block void-image" + (selected ? " selected" : "")}
      style={{ width: w ? `${w}px` : undefined }}
      onDblClick={onPreview}
    >
      <img
        ref={imgRef}
        src={block.src}
        alt={block.name ?? ""}
        loading="lazy"
        draggable={false}
        title="双击预览 / 标注"
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
  return (
    <div class="void-block void-media void-video">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video src={block.src} controls preload="metadata" />
    </div>
  );
}

export function AudioBlock({ block }: { block: Block }) {
  return (
    <div class="void-block void-media void-audio">
      {block.name && <div class="void-audio-name">{block.name}</div>}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio src={block.src} controls preload="metadata" />
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
