/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CmDocBody, type CmHandle } from "../cm6/CmDocBody";
import { DocumentSaveQueue, type DocumentSaveResult, type DocumentSaveState } from "../document-save";
import { isDraft, type EditorDraft, type EditorMediaRequest } from "../../../apps/mobile/src/lib/editor/protocol";
import { onCommand, post, rpc } from "./bridge";

function App() {
  const cm = useRef<CmHandle | null>(null);
  const title = useRef("");
  const body = useRef("");
  const revision = useRef(0);
  const titleInput = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState<DocumentSaveState>("saved");
  const [mode, setMode] = useState<"blocks" | "source">("blocks");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const applyingRemote = useRef(false);
  const refreshPending = useRef(false);
  const refreshing = useRef(false);
  const retryLoad = useRef<() => void>(() => {});
  const checkpointChain = useRef<Promise<unknown>>(Promise.resolve());
  const snapshot = (): EditorDraft => ({ revision: revision.current, title: title.current, body: cm.current?.getDoc() ?? body.current, version: saver.version });
  const saverRef = useRef<DocumentSaveQueue | null>(null);
  if (!saverRef.current) saverRef.current = new DocumentSaveQueue({
    snapshot: () => snapshot(),
    write: async (value, version, force) => {
      await checkpointChain.current;
      return rpc<{ version: string | null }>("save", { ...value, revision: (value as EditorDraft).revision, version, force });
    },
    isConflict: e => (e as { code?: string })?.code === "stale",
    changed: next => {
      setState(next);
      const message = saverRef.current?.error ?? "";
      if (next === "error" || next === "conflict") setError(message);
      if (next === "saved") { setError(""); if (refreshPending.current && !refreshing.current) void refreshDocument(); }
      post({ type: "state", state: next, error: message });
    },
  });
  const saver = saverRef.current;
  const checkpoint = () => {
    const draft = snapshot();
    const write = () => rpc("checkpoint", draft);
    const pending = checkpointChain.current.then(write, write);
    checkpointChain.current = pending;
    void pending.catch(e => { setError(String(e.message)); post({ type: "state", state: "error", error: String(e.message) }); });
    return pending;
  };
  const edit = () => {
    if (applyingRemote.current) return;
    body.current = cm.current?.getDoc() ?? body.current;
    revision.current++;
    saver.edit();
    void checkpoint();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void saver.save(), 650);
  };
  const flush = async (): Promise<DocumentSaveResult> => {
    clearTimeout(timer.current);
    // Stop further input while a close/navigation snapshot is being accepted.
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    try { await checkpointChain.current; return await saver.flush(); }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
  const refreshDocument = async () => {
    refreshPending.current = true;
    if (refreshing.current || saver.dirty || !cm.current) return;
    refreshing.current = true;
    try {
      while (refreshPending.current && !saver.dirty) {
        refreshPending.current = false;
        const savedRevision = saver.revision, savedVersion = saver.version;
        const doc = await rpc<{ title: string; body: string; version: string | null }>("refresh");
        if (!isDraft({ ...doc, revision: 0 })) throw new Error("无效的文档更新");
        if (!saver.canRefresh(savedRevision, savedVersion)) { refreshPending.current = true; continue; }
        applyingRemote.current = true;
        try { cm.current?.setDoc(doc.body); title.current = doc.title; body.current = doc.body; if (titleInput.current) titleInput.current.value = doc.title; saver.reset(doc.version); }
        finally { applyingRemote.current = false; }
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { refreshing.current = false; }
  };
  const displayMode = (next: "blocks" | "source") => { cm.current?.setSource(next === "source"); setMode(next); };
  useEffect(() => {
    let alive = true;
    let loading = false;
    const load = async () => {
      if (loading || !alive) return;
      loading = true; setError("");
      try {
        const doc = await rpc<EditorDraft & { recovered: boolean }>("load");
        if (!alive) return;
        if (!isDraft(doc)) throw new Error("Invalid document received from native host");
        title.current = doc.title;
        body.current = doc.body;
        revision.current = doc.revision;
        saver.reset(doc.version);
        // A restored checkpoint is local work; it must be saved through the same
        // optimistic queue before it can be called clean.
        if (doc.recovered) saver.edit();
        setLoaded(true);
        if (doc.recovered) timer.current = setTimeout(() => void saver.save(), 650);
      } catch (e) {
        if (alive) { const message = e instanceof Error ? e.message : String(e); setError(message); post({ type: "state", state: "error", error: message }); }
      } finally { loading = false; }
    };
    // Keep bridge request IDs monotonic. Reloading the page would reuse IDs
    // that the native host has already accepted and intentionally deduplicates.
    retryLoad.current = () => { void load(); };
    void load();
    onCommand(command => {
      if (command.method === "refresh") { void refreshDocument().then(() => post({ type: "result", id: command.id, ok: true })); }
      else if (command.method === "mode") { displayMode(command.mode!); post({ type: "result", id: command.id, ok: true }); }
      else void flush().then(result => post({ type: "result", id: command.id, ...result }));
    });
    return () => { alive = false; retryLoad.current = () => {}; clearTimeout(timer.current); };
  }, []);
  const navigate = async (target: string) => {
    const result = await flush();
    if (result.ok === false) { setError(result.error); return; }
    await rpc("navigate", target).catch(e => setError(String(e.message)));
  };
  useEffect(() => {
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.("a");
      if (!anchor) return;
      event.preventDefault(); event.stopPropagation();
      void navigate(anchor.getAttribute("href") ?? "");
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
  const attach = async (kind: "file" | "image" | "video" = "file") => {
    try {
      const result = await rpc<{ src?: string; name?: string; mime?: string }>("media", { action: "pick", kind } satisfies EditorMediaRequest);
      if (!result.src) return;
      if (!/^\/blob\/[\w.-]+$/.test(result.src)) throw new Error("Invalid attachment reference");
      const name = (result.name || "附件").replace(/[\[\]\\\r\n]/g, "_");
      const image = /^(image|audio|video)\//.test(result.mime ?? "");
      const view = cm.current?.view;
      if (view) view.dispatch({ changes: { from: view.state.selection.main.head, insert: `\n${image ? "!" : ""}[${name}](${result.src})\n` } });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <main class="mobile-editor">
    <div class="mobile-toolbar"><button onClick={() => displayMode(mode === "blocks" ? "source" : "blocks")}>{mode === "blocks" ? "Markdown" : "富文本"}</button><button onClick={() => void attach("image")}>照片</button><button onClick={() => void attach("video")}>视频</button><button onClick={() => void attach()}>附件</button><span role="status">{{ saved: "已保存", dirty: "保存中…", saving: "保存中…", conflict: "保存冲突", error: "保存失败" }[state]}</span></div>
    {error && <div class="mobile-error" role="alert">{error}<button onClick={() => { if (loaded) { void checkpoint().then(() => saver.save()).catch(e => setError(String(e.message))); } else retryLoad.current(); }}>重试</button>{state === "conflict" && <button onClick={() => { if (confirm("用本地草稿覆盖已保存的版本？")) void saver.save(true); }}>覆盖保存</button>}</div>}
    {loaded ? <div class="doc doc-embed"><input ref={titleInput} aria-label="文档标题" class="doc-title mobile-title" placeholder="无标题" defaultValue={title.current} onInput={e => { title.current = e.currentTarget.value; edit(); }} /><CmDocBody initialDoc={body.current} embedded disableUploads source={mode === "source"} onReady={handle => { cm.current = handle; if (refreshPending.current) void refreshDocument(); }} onChange={edit} onExitTop={() => titleInput.current?.focus()} onError={setError} onPreviewImage={block => void rpc("media", { action: "preview", src: block.src, kind: "image" }).catch(e => setError(String(e.message)))} /></div> : !error && <p role="status">正在载入文档…</p>}
  </main>;
}
document.documentElement.dataset.resolved = window.__METAHUB_EDITOR__.dark ? "dark" : "light";
render(<App />, document.getElementById("app")!);
