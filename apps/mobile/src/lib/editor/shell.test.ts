import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Window } from "happy-dom";
import { editorHTML } from "./editor-bundle";
import { scriptJSON } from "./protocol";

test("packaged CM6 shell opens offline and checkpoints title/body through native bridge", async () => {
  const window = new Window({ url: "about:blank", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const messages: { type: string; method?: string; params?: Record<string, unknown>; id?: number }[] = [];
  let requests = 0;
  const canonical = `/blob/${"a".repeat(32)}.png`;
  let remote = { title: "Offline document", body: `# Heading\n\nOffline body\n\n![Cached image](${canonical})`, version: "v1" };
  // Never needs a server page, WebSocket, browser replica or credential.
  window.fetch = (() => { requests++; throw new Error("network disabled"); }) as typeof window.fetch;
  const bootstrap = { session: "offline-test", documentId: "doc_test", dark: false };
  Object.assign(window, { __METAHUB_EDITOR__: bootstrap, ReactNativeWebView: { postMessage(raw: string) {
    const message = JSON.parse(raw); messages.push(message);
    if (message.type !== "request") return;
    if (message.method === "save") remote = { title: message.params.title, body: message.params.body, version: "v2" };
    const value = message.method === "load" ? { ...remote, revision: 0, recovered: false } : message.method === "refresh" ? remote : message.method === "targets" ? [] : message.method === "save" ? { version: "v2" } : message.method === "media" ? { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxioAAAAASUVORK5CYII=" } : null;
    queueMicrotask(() => (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive({ v: 1, session: bootstrap.session, type: "response", id: message.id, ok: true, value }));
  } } });
  const html = editorHTML.replace("__METAHUB_BOOTSTRAP__", scriptJSON(bootstrap));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);
  window.document.body.innerHTML = '<div id="app"></div>';
  try {
    const sandbox = Object.fromEntries(Object.getOwnPropertyNames(window).map(key => [key, (window as unknown as Record<string, unknown>)[key]]).filter(([, value]) => value !== undefined));
    const context = createContext({ ...sandbox, window, document: window.document, console });
    for (const script of scripts) runInContext(script, context);
    const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Shell did not become ready"); };
    await waitFor(() => !!window.document.querySelector(".cm-editor"));
    const title = window.document.querySelector("input")!;
    expect(title.value).toBe("Offline document");
    expect(window.document.querySelector(".cm-content")?.textContent).toContain("Offline body");
    await waitFor(() => !!window.document.querySelector("img[src^='data:image/']"));
    expect(messages.some(message => message.method === "media" && message.params?.src === canonical)).toBe(true);
    title.value = "Offline edit"; title.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => messages.some(message => message.method === "checkpoint"));
    expect(messages.find(message => message.method === "checkpoint")?.params?.title).toBe("Offline edit");
    (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive({ v: 1, session: bootstrap.session, type: "command", id: 99, method: "flush" });
    await waitFor(() => messages.some(message => message.type === "result" && message.id === 99));
    expect(messages.some(message => message.method === "save")).toBe(true);
    const checkpoints = messages.filter(message => message.method === "checkpoint").length;
    remote = { title: "Synced elsewhere", body: "New remote body", version: "v3" };
    (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive({ v: 1, session: bootstrap.session, type: "command", id: 100, method: "refresh" });
    await waitFor(() => messages.some(message => message.type === "result" && message.id === 100));
    expect(title.value).toBe("Synced elsewhere");
    expect(window.document.querySelector(".cm-content")?.textContent).toContain("New remote body");
    expect(messages.filter(message => message.method === "checkpoint")).toHaveLength(checkpoints);
    expect(requests).toBe(0);
    expect(html).toContain("connect-src 'none'"); expect(html).not.toContain("mh_token"); expect(html).not.toContain("db-worker");
  } finally { await window.happyDOM.close(); }
});

test("failed initial load retries through the same host with fresh request IDs", async () => {
  const { EditorHost } = await import("./host");
  const window = new Window({ url: "about:blank", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const bootstrap = { session: "retry-test", documentId: "doc_retry", dark: false };
  let loads = 0;
  const ids: number[] = [];
  const host = new EditorHost(bootstrap.session, {
    async load() { if (++loads === 1) throw new Error("temporary read failure"); return { title: "Recovered after retry", body: "Offline text", version: "v1" }; },
    async readDraft() { return null; }, async checkpoint() {}, async acknowledge() {},
    async save() { return { version: "v2" }; }, isCurrent: () => true,
  });
  Object.assign(window, { __METAHUB_EDITOR__: bootstrap, ReactNativeWebView: { postMessage(raw: string) {
    const message = JSON.parse(raw);
    if (message.type !== "request") return;
    ids.push(message.id);
    void host.request(message).then(response => { if (response) (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive(response); });
  } } });
  window.document.body.innerHTML = '<div id="app"></div>';
  try {
    const sandbox = Object.fromEntries(Object.getOwnPropertyNames(window).map(key => [key, (window as unknown as Record<string, unknown>)[key]]).filter(([, value]) => value !== undefined));
    const context = createContext({ ...sandbox, window, document: window.document, console });
    const html = editorHTML.replace("__METAHUB_BOOTSTRAP__", scriptJSON(bootstrap));
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInContext(script[1]!, context);
    const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(10); } throw new Error("Shell retry did not become ready"); };
    await waitFor(() => !!window.document.querySelector(".mobile-error"));
    expect(window.document.querySelector(".mobile-error")?.textContent).toContain("temporary read failure");
    window.document.querySelector(".mobile-error")!.querySelector("button")!.click();
    await waitFor(() => !!window.document.querySelector(".cm-editor"));
    expect(window.document.querySelector("input")?.value).toBe("Recovered after retry");
    expect(loads).toBe(2); expect(ids).toEqual([1, 2]);
  } finally { host.dispose(); await window.happyDOM.close(); }
});
