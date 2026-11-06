import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Window } from "happy-dom";
import { editorHTML } from "./editor-bundle";
import { scriptJSON } from "./protocol";

function listenerCount(target: EventTarget) {
  const active = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const key = (type: string, options?: boolean | EventListenerOptions) =>
    type + ":" + (typeof options === "boolean" ? options : !!options?.capture);
  target.addEventListener = (type, listener, options) => {
    if (listener && !(typeof options === "object" && (options.once || options.signal))) {
      const event = key(type, options);
      const group = active.get(event) ?? new Set();
      group.add(listener);
      active.set(event, group);
    }
    add(type, listener, options);
  };
  target.removeEventListener = (type, listener, options) => {
    if (listener) active.get(key(type, options))?.delete(listener);
    remove(type, listener, options);
  };
  return () => [...active.values()].reduce((sum, group) => sum + group.size, 0);
}

test.each(["embedded", "prewarmed"])("packaged %s CM6 shell opens offline and checkpoints through the native bridge", async mode => {
  const window = new Window({ url: "about:blank", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const documentListeners = listenerCount(window.document as unknown as EventTarget);
  const windowListeners = listenerCount(window as unknown as EventTarget);
  const messages: { type: string; method?: string; params?: Record<string, unknown>; id?: number }[] = [];
  let requests = 0;
  const canonical = `/blob/${"a".repeat(32)}.png`;
  let remote = { title: "Offline document", body: `# Heading\n\nOffline body\n\n![Cached image](${canonical})`, version: "v1" };
  // Never needs a server page, WebSocket, browser replica or credential.
  window.fetch = (() => { requests++; throw new Error("network disabled"); }) as typeof window.fetch;
  const bootstrap = { session: "offline-test", documentId: "doc_test", dark: false, initial: { ...remote, revision: 0, recovered: false } };
  Object.assign(window, { __METAHUB_EDITOR__: bootstrap, ReactNativeWebView: { postMessage(raw: string) {
    const message = JSON.parse(raw); messages.push(message);
    if (message.type !== "request") return;
    if (message.method === "save") remote = { title: message.params.title, body: message.params.body, version: "v2" };
    const value = message.method === "load" ? { ...remote, revision: 0, recovered: false } : message.method === "refresh" ? remote : message.method === "targets" ? [] : message.method === "save" ? { version: "v2" } : message.method === "media" ? (message.params.action === "pick" ? { src: canonical, name: "Picked attachment", mime: "image/png" } : { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxioAAAAASUVORK5CYII=" }) : null;
    queueMicrotask(() => (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive({ v: 1, session: message.session, type: "response", id: message.id, ok: true, value }));
  } } });
  const html = editorHTML.replace("__METAHUB_BOOTSTRAP__", () => mode === "prewarmed" ? "null" : scriptJSON(bootstrap));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);
  window.document.body.innerHTML = '<div id="app"></div>';
  try {
    const sandbox = Object.fromEntries(Object.getOwnPropertyNames(window).map(key => [key, (window as unknown as Record<string, unknown>)[key]]).filter(([, value]) => value !== undefined));
    const context = createContext({ ...sandbox, window, document: window.document, console, structuredClone });
    for (const script of scripts) runInContext(script, context);
    if (mode === "prewarmed") {
      expect(messages).toHaveLength(0);
      expect(window.document.querySelector(".cm-editor")).toBeNull();
      const runtime = window as unknown as { __metahubOpenSession(options: typeof bootstrap): void };
      runtime.__metahubOpenSession(bootstrap);
      expect(() => runtime.__metahubOpenSession(bootstrap)).toThrow("上一文档");
    }
    const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Shell did not become ready"); };
    await waitFor(() => !!window.document.querySelector(".cm-editor"));
    expect(messages.some(message => message.type === "ready")).toBe(true);
    const title = window.document.querySelector("input")!;
    expect(title.value).toBe("Offline document");
    expect(messages.some(message => message.method === "load")).toBe(false);
    expect(window.document.querySelector(".cm-content")?.textContent).toContain("Offline body");
    await waitFor(() => !!window.document.querySelector("img[src^='data:image/']"));
    expect(messages.some(message => message.method === "media" && message.params?.src === canonical)).toBe(true);
    title.value = "Offline edit"; title.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => messages.some(message => message.method === "checkpoint"));
    if (mode === "prewarmed") {
      const runtime = window as unknown as { __metahubCloseSession(id: string): unknown };
      expect(runtime.__metahubCloseSession(bootstrap.session)).toEqual({ blocked: true });
      expect(window.document.querySelectorAll(".cm-editor")).toHaveLength(1);
    }
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
    if (mode === "prewarmed") {
      const runtime = window as unknown as {
        __metahubOpenSession(config: typeof bootstrap & { position?: { anchor: number; head: number; scroll: number; version: string } }): void;
        __metahubCloseSession(id: string): unknown;
      };
      let owner = bootstrap.session;
      let idleListeners = Infinity;
      for (let i = 0; i < 20; i++) {
        expect(runtime.__metahubCloseSession("late-session")).toBe(false);
        expect(runtime.__metahubCloseSession(owner)).toMatchObject({ anchor: 0 });
        expect(window.document.querySelector(".cm-editor")).toBeNull();
        const remaining = documentListeners() + windowListeners();
        expect(remaining).toBeLessThanOrEqual(idleListeners);
        idleListeners = remaining;
        owner = "owner-" + i;
        runtime.__metahubOpenSession({ ...bootstrap, session: owner,
          initial: { ...remote, body: "body-" + i, revision: 0, recovered: false } });
        await waitFor(() => !!window.document.querySelector(".cm-editor"));
        expect(window.document.querySelectorAll(".cm-editor")).toHaveLength(1);
        expect(window.document.querySelector(".cm-content")?.textContent).toBe("body-" + i);
      }
      const content = window.document.querySelector(".cm-content")!;
      content.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }));
      expect(content.textContent).toBe("body-19");
      runtime.__metahubCloseSession(owner);
      runtime.__metahubOpenSession({ ...bootstrap, session: "shortened",
        position: { anchor: 5, head: 50, scroll: 0, version: "v1" },
        initial: { ...remote, body: "abc", revision: 0, recovered: false } });
      await waitFor(() => !!window.document.querySelector(".cm-editor"));
      expect(runtime.__metahubCloseSession("shortened")).toMatchObject({ anchor: 3, head: 3, version: remote.version });
      runtime.__metahubOpenSession({ ...bootstrap, session: "shortened", initial: { ...remote, revision: 0, recovered: false } });
      await waitFor(() => !!window.document.querySelector(".cm-editor"));
    }
    // Native menu and toolbar commands act on the existing CM6 session, including a reused page.
    const session = mode === "prewarmed" ? "shortened" : bootstrap.session;
    const send = async (id: number, method: string, extra: Record<string, string> = {}) => {
      (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive({ v: 1, session, type: "command", id, method, ...extra });
      await waitFor(() => messages.some(message => message.type === "result" && message.id === id));
      expect(messages.find(message => message.type === "result" && message.id === id)).toMatchObject({ ok: true });
    };
    const originalBody = remote.body;
    const originalTitle = remote.title;
    await send(200, "mode", { mode: "source" });
    await send(201, "mode", { mode: "blocks" });
    await send(202, "flush");
    expect(remote).toMatchObject({ body: originalBody, title: originalTitle });
    // Native formatting uses the current caret and can be toggled back without losing content.
    for (const [index, format] of ["bold", "italic", "inlineCode"].entries()) {
      await send(300 + index * 3, "format", { format });
      await send(301 + index * 3, "format", { format });
      await send(302 + index * 3, "flush");
      expect(remote.body).toBe(originalBody);
    }
    for (let step = 0; step < 4; step++) await send(320 + step, "format", { format: "heading" });
    await send(324, "flush");
    expect(remote.body).toBe(originalBody);
    for (const [index, kind] of ["library", "image", "video", "audio", "file"].entries()) {
      await send(210 + index, "attach", { kind });
      expect(messages.some(message => message.method === "media" && message.params?.action === "pick" && message.params.kind === kind)).toBe(true);
    }
    await send(220, "flush");
    expect(remote.body.match(/Picked attachment/g)).toHaveLength(5);
    for (const [index, block] of ["p", "h1", "h2", "h3", "bullet", "numbered", "todo", "quote", "code", "table", "divider", "html"].entries()) {
      await send(230 + index, "block", { block });
    }
    await send(250, "flush");
    expect(remote.title).toBe(originalTitle);
    expect(remote.body.match(/Picked attachment/g)).toHaveLength(5);
    for (const marker of ["# ", "## ", "### ", "- ", "1. ", "- [ ] ", "> ", "```", "| --- |", "---", "```mh-html"]) expect(remote.body).toContain(marker);
    expect(window.document.querySelector(".mobile-toolbar")).toBeNull();
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
    const context = createContext({ ...sandbox, window, document: window.document, console, structuredClone });
    const html = editorHTML.replace("__METAHUB_BOOTSTRAP__", () => scriptJSON(bootstrap));
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

test("packaged attachment controls and CM6 links reach the native host without stealing source edits", async () => {
  const window = new Window({ url: "about:blank", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const bootstrap = { session: "attachment-test", documentId: "doc_attachment", dark: false };
  const src = `/blob/${"b".repeat(32)}.txt`;
  const messages: { type: string; method?: string; params?: unknown; id?: number }[] = [];
  let browserOpens = 0;
  let failSave = false;
  window.open = (() => { browserOpens++; return null; }) as typeof window.open;
  Object.assign(window, { __METAHUB_EDITOR__: bootstrap, ReactNativeWebView: { postMessage(raw: string) {
    const message = JSON.parse(raw); messages.push(message);
    if (message.type !== "request") return;
    const value = message.method === "load" ? { title: "Attachments", body: `[Editing](${src}) in prose\n\nA collapsed [attachment](${src}) in prose\n\n[report.txt](${src})`, version: "v1", revision: 0, recovered: false } : message.method === "targets" ? [] : message.method === "save" ? { version: "v2" } : null;
    queueMicrotask(() => (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive({ v: 1, session: bootstrap.session, type: "response", id: message.id, ok: !(failSave && message.method === "save"), value, error: "Attachment save failed" }));
  } } });
  window.document.body.innerHTML = '<div id="app"></div>';
  try {
    const sandbox = Object.fromEntries(Object.getOwnPropertyNames(window).map(key => [key, (window as unknown as Record<string, unknown>)[key]]).filter(([, value]) => value !== undefined));
    const context = createContext({ ...sandbox, window, document: window.document, console, structuredClone });
    const html = editorHTML.replace("__METAHUB_BOOTSTRAP__", () => scriptJSON(bootstrap));
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInContext(script[1]!, context);
    const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(10); } throw new Error("Attachment shell did not become ready"); };
    await waitFor(() => !!window.document.querySelector(".void-file button"));
    // The explicit rich-mode preview must save dirty text before opening.
    const title = window.document.querySelector("input")!;
    title.value = "Saved before preview"; title.dispatchEvent(new window.Event("input", { bubbles: true }));
    window.document.querySelector(".void-file")!.querySelector("button")!.click();
    await waitFor(() => messages.some(message => message.method === "media" && (message.params as { action?: string })?.action === "preview"));
    expect(messages.find(message => message.method === "media")?.params).toEqual({ action: "preview", src, kind: "file" });
    expect(messages.findIndex(message => message.method === "save")).toBeLessThan(messages.findIndex(message => message.method === "media"));
    const editing = window.document.querySelector("[data-href][data-md-revealed]")!;
    expect(editing).not.toBeNull();
    editing.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await Bun.sleep(20);
    expect(messages.filter(message => message.method === "navigate")).toHaveLength(0);
    // A collapsed link is an open action, and must save before opening natively.
    title.value = "Saved before attachment"; title.dispatchEvent(new window.Event("input", { bubbles: true }));
    const collapsed = window.document.querySelector("[data-href]:not([data-md-revealed])")!;
    collapsed.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await waitFor(() => messages.some(message => message.method === "navigate"));
    expect(messages.find(message => message.method === "navigate")?.params).toBe(src);
    expect(messages.findIndex(message => message.method === "save")).toBeLessThan(messages.findIndex(message => message.method === "navigate"));
    expect(browserOpens).toBe(0);
    editing.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    await waitFor(() => messages.filter(message => message.method === "navigate").length === 2);
    expect(browserOpens).toBe(0);
    failSave = true;
    title.value = "Retain failed preview edit"; title.dispatchEvent(new window.Event("input", { bubbles: true }));
    const previews = messages.filter(message => message.method === "media").length;
    window.document.querySelector(".void-file")!.querySelector("button")!.click();
    await waitFor(() => window.document.querySelector(".mobile-error")?.textContent?.includes("Attachment save failed") === true);
    expect(window.document.querySelector(".mobile-error")?.textContent).toContain("Attachment save failed");
    expect(messages.filter(message => message.method === "media")).toHaveLength(previews);
    expect(title.value).toBe("Retain failed preview edit");
    expect(messages.filter(message => message.method === "checkpoint").at(-1)?.params).toMatchObject({ title: "Retain failed preview edit" });
  } finally { await window.happyDOM.close(); }
});

test("packaged CM6 document references save then route natively with partial target lists and reject invalid IDs", async () => {
  const window = new Window({ url: "about:blank", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const bootstrap = { session: "doclink-test", documentId: "doc_current", dark: false };
  const messages: { type: string; method?: string; params?: unknown; id?: number }[] = [];
  let failSave = false;
  const storedTargets = [{ id: "doc_target", title: "Linked document", kind: "doc" }, { id: "db_target", title: "Linked database", kind: "db" }, { id: "doc_unlisted", title: "Document beyond candidate limit", kind: "doc" }];
  Object.assign(window, { __METAHUB_EDITOR__: bootstrap, ReactNativeWebView: { postMessage(raw: string) {
    const message = JSON.parse(raw); messages.push(message);
    if (message.type !== "request") return;
    if (message.method === "navigate") expect(storedTargets.some(target => message.params === `/${target.kind}/${target.id}`)).toBe(true);
    const value = message.method === "load" ? { title: "References", body: "[[doc_target]] editing\n\nOpen [[doc_target]]\n\nOpen [[db_target]]\n\nOpen [[doc_unlisted|Unlisted alias]]\n\nAn [unsafe](javascript:alert) link", version: "v1", revision: 0, recovered: false } : message.method === "targets" ? storedTargets.slice(0, 2) : message.method === "save" ? { version: "v2" } : null;
    queueMicrotask(() => (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive({ v: 1, session: bootstrap.session, type: "response", id: message.id, ok: !(failSave && message.method === "save"), value, error: "Reference save failed" }));
  } } });
  window.document.body.innerHTML = '<div id="app"></div>';
  try {
    const sandbox = Object.fromEntries(Object.getOwnPropertyNames(window).map(key => [key, (window as unknown as Record<string, unknown>)[key]]).filter(([, value]) => value !== undefined));
    const context = createContext({ ...sandbox, window, document: window.document, console, structuredClone });
    const html = editorHTML.replace("__METAHUB_BOOTSTRAP__", () => scriptJSON(bootstrap));
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInContext(script[1]!, context);
    const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(10); } throw new Error("Reference shell did not become ready"); };
    await waitFor(() => window.document.querySelector('[data-doclink="db_target"]')?.textContent === "Linked database");
    const press = (selector: string, mod = false) => {
      const element = window.document.querySelector(selector);
      expect(element).not.toBeNull();
      element!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: mod }));
    };
    // Source clicks still edit, including a revealed internal reference.
    press('[data-doclink="doc_target"][data-md-revealed]');
    await Bun.sleep(20);
    expect(messages.filter(message => message.method === "navigate")).toHaveLength(0);
    const title = window.document.querySelector("input")!;
    title.value = "Saved before document navigation"; title.dispatchEvent(new window.Event("input", { bubbles: true }));
    press('[data-doclink="doc_target"]:not([data-md-revealed])');
    await waitFor(() => messages.some(message => message.method === "navigate"));
    expect(messages.find(message => message.method === "navigate")?.params).toBe("/doc/doc_target");
    expect(messages.findIndex(message => message.method === "save")).toBeLessThan(messages.findIndex(message => message.method === "navigate"));
    press('[data-doclink="db_target"]');
    await waitFor(() => messages.filter(message => message.method === "navigate").length === 2);
    expect(messages.filter(message => message.method === "navigate").at(-1)?.params).toBe("/db/db_target");
    press('[data-doclink="doc_target"][data-md-revealed]', true);
    await waitFor(() => messages.filter(message => message.method === "navigate").length === 3);
    expect(window.location.hash).toBe("");
    // Candidates are a bounded suggestion list, not proof that an ID is missing.
    // This document exists in native storage but is omitted from that list.
    press('[data-doclink="doc_unlisted"]');
    await waitFor(() => messages.filter(message => message.method === "navigate").length === 4);
    expect(messages.filter(message => message.method === "navigate").at(-1)?.params).toBe("/doc/doc_unlisted");
    press('[data-href^="javascript:"]');
    await Bun.sleep(20);
    expect(messages.filter(message => message.method === "navigate")).toHaveLength(4);
    // Even an alias must not allow a non-id target into native navigation.
    window.document.querySelector('[data-doclink="doc_unlisted"]')!.setAttribute("data-doclink", "javascript:alert");
    press('[data-doclink="javascript:alert"]');
    expect(messages.filter(message => message.method === "navigate")).toHaveLength(4);
    failSave = true;
    title.value = "Keep this failed-navigation draft"; title.dispatchEvent(new window.Event("input", { bubbles: true }));
    press('[data-doclink="doc_target"]:not([data-md-revealed])');
    await waitFor(() => window.document.querySelector(".mobile-error")?.textContent?.includes("Reference save failed") === true);
    expect(messages.filter(message => message.method === "navigate")).toHaveLength(4);
    expect(messages.filter(message => message.method === "checkpoint").at(-1)?.params).toMatchObject({ title: "Keep this failed-navigation draft" });
    expect(title.value).toBe("Keep this failed-navigation draft");
  } finally { await window.happyDOM.close(); }
});

test("preview guard cleanup blocks old in-flight previews and retains a newer owner", async () => {
  const window = new Window({ url: "about:blank" });
  const source = new URL("../../../../../src/webui/mobile-editor/bridge.ts", import.meta.url).pathname;
  const built = await Bun.build({ entrypoints: [source], target: "browser", format: "iife", plugins: [{ name: "expose-preview-guard", setup(build) {
    build.onLoad({ filter: /mobile-editor\/bridge\.ts$/ }, async args => ({ loader: "ts", contents: `${await Bun.file(args.path).text()}\nObject.assign(window, { testBridge: bindBridge("guard-owner-test"), bindBridge, releaseBridge });` }));
  } }] });
  expect(built.success).toBe(true);
  const previews: unknown[] = [];
  Object.assign(window, { __METAHUB_EDITOR__: { session: "guard-owner-test" }, ReactNativeWebView: { postMessage(raw: string) {
    const request = JSON.parse(raw); previews.push(request.params);
    queueMicrotask(() => (window as unknown as { __metahubEditorReceive(value: unknown): void }).__metahubEditorReceive({ v: 1, session: "guard-owner-test", type: "response", id: request.id, ok: true }));
  } } });
  try {
    runInContext(await built.outputs[0]!.text(), createContext({ window, setTimeout, clearTimeout }));
    const bridge = (window as unknown as { testBridge: import("../../../../../src/webui/mobile-editor/bridge").EditorBridge }).testBridge;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const removeOld = bridge.onBeforeMediaPreview(() => blocked);
    const oldPreview = bridge.previewMedia(`/blob/${"c".repeat(32)}.txt`, "file");
    removeOld(); // unmount while its save is still pending
    let newSaves = 0;
    const removeNew = bridge.onBeforeMediaPreview(async () => { newSaves++; });
    removeOld(); // a late cleanup must not remove the replacement's guard
    release();
    await expect(oldPreview).rejects.toThrow("文档会话已结束");
    expect(previews).toHaveLength(0);
    await bridge.previewMedia(`/blob/${"d".repeat(32)}.txt`, "file");
    expect(newSaves).toBe(1);
    expect(previews).toHaveLength(1);
    removeNew();
    await expect(bridge.previewMedia(`/blob/${"d".repeat(32)}.txt`, "file")).rejects.toThrow("编辑器尚未就绪");
    expect(previews).toHaveLength(1);
    const runtime = window as unknown as Pick<typeof import("../../../../../src/webui/mobile-editor/bridge"), "bindBridge" | "releaseBridge">;
    runtime.releaseBridge(bridge);
    const calls: { id: number; session: string }[] = [];
    Object.assign(window, { ReactNativeWebView: { postMessage(raw: string) {
      expect(arguments.length).toBe(1); // Android exposes a single-argument Java method.
      calls.push(JSON.parse(raw));
    } } });
    const first = runtime.bindBridge("A");
    const abandoned = first.rpc("targets");
    runtime.releaseBridge(first);
    await expect(abandoned).rejects.toThrow("会话已结束");
    Object.assign(window, { ReactNativeWebView: { sessionProtocol: 2, postMessage(raw: string, session: string) {
      expect(session).toBe("B");
      calls.push(JSON.parse(raw));
    } } });
    const second = runtime.bindBridge("B");
    const pending = second.rpc("targets");
    expect(calls).toMatchObject([{ id: 1, session: "A" }, { id: 1, session: "B" }]);
    second.receive({ v: 1, type: "response", id: 1, session: "A", ok: true, value: "stale" });
    second.receive({ v: 1, type: "response", id: 1, session: "B", ok: true, value: "current" });
    expect(await pending).toBe("current");
    runtime.releaseBridge(second);
  } finally { await window.happyDOM.close(); }
});
