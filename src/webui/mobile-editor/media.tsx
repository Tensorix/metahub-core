/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import type { Block } from "../blocks";
import { rpc } from "./bridge";

/** Mount actual media only after native persistence resolves its bytes. This
 * avoids an initial /blob request, credentials, and CSP/onError races. */
function NativeMedia({ block, kind, onPreview }: { block: Block; kind: "image" | "video" | "audio" | "file"; onPreview?(): void }) {
  const [url, setURL] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true; setURL(""); setError(""); setReady(false);
    if (kind === "file") return () => { alive = false; };
    void rpc<{ url?: string }>("media", { action: "resolve", src: block.src, kind }).then(value => {
      if (!alive) return;
      if (value.url && !/^data:/.test(value.url)) throw new Error("无效的附件地址");
      setURL(value.url ?? ""); setReady(true);
    }).catch(error => { if (alive) setError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, [block.src, kind, attempt]);
  const preview = () => {
    if (onPreview) { onPreview(); return; }
    void rpc("media", { action: "preview", src: block.src, kind }).catch(error => setError(String(error.message)));
  };
  return <div class={`void-block void-${kind}`} style={{ maxWidth: "100%" }}>
    {url && kind === "image" && <img src={url} alt={block.name ?? "图片"} style={{ maxWidth: "100%", width: block.width ? `${block.width}px` : undefined }} onClick={preview} onError={() => setError("图片无法显示，请打开附件预览")} />}
    {url && kind === "video" && <video src={url} controls preload="metadata" style={{ maxWidth: "100%" }} />}
    {url && kind === "audio" && <audio src={url} controls preload="metadata" style={{ maxWidth: "100%" }} />}
    {(kind === "file" || ready && !url) && <button onClick={preview}>{kind === "file" ? "下载 / 打开" : "已下载 · 打开"} {block.name || "附件"}</button>}
    {!ready && kind !== "file" && !error && <span role="status">正在读取附件…</span>}
    {error && <div role="alert">{error}<button onClick={() => { setError(""); setAttempt(value => value + 1); }}>重试</button><button onClick={preview}>下载 / 打开</button></div>}
  </div>;
}
export function ImageBlock({ block, onPreview }: { block: Block; selected?: boolean; onResize?(width: number | undefined): void; onPreview(): void }) { return <NativeMedia block={block} kind="image" onPreview={onPreview} />; }
export function VideoBlock({ block }: { block: Block }) { return <NativeMedia block={block} kind="video" />; }
export function AudioBlock({ block }: { block: Block }) { return <NativeMedia block={block} kind="audio" />; }
export function FileBlock({ block }: { block: Block }) { return <NativeMedia block={block} kind="file" />; }
export function UploadingBlock({ block }: { block: Block }) { return <div role="status">正在保存 {block.name || "附件"}…</div>; }
