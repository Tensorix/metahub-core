/** @jsxImportSource preact */
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { t } from "./i18n/t.ts";
import { consumeKey, imeGhost, isEditableTarget } from "./keys.ts";
import { shortcutAvailable } from "./shortcuts.ts";
import { Kbd } from "./kbd.tsx";

// Imperative UI primitives (Toast / Menu / Modal) backed by tiny external
// stores, so any code can pop a menu or dialog without prop-drilling. Mount
// <UiHost/> once at the app root. Replaces native alert/prompt/confirm.

/** The phone layout/interaction gate (see the mobile block in styles.css and
 *  useIsMobile in app.tsx — all three key off this same query). */
export const MOBILE_MQ = "(max-width: 768px) and (pointer: coarse)";

function makeStore<T>(init: T) {
  let value = init;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      subs.forEach((f) => f(v));
    },
    use(): T {
      const [v, setV] = useState(value);
      useEffect(() => {
        subs.add(setV);
        return () => void subs.delete(setV);
      }, []);
      return v;
    },
  };
}

// ---- toasts ----------------------------------------------------------------
export type ToastTone = "ok" | "error" | "info";
export interface ToastOpts {
  tone?: ToastTone;
  action?: { label: string; run: () => void | Promise<void> };
  ms?: number;
}
type Toast = { id: number; msg: string; tone: ToastTone; action?: ToastOpts["action"]; leaving?: boolean };
const toastStore = makeStore<Toast[]>([]);
let toastSeq = 0;
const toastTimers = new Map<number, { t: number; due: number; left: number }>();
function armToast(id: number, left: number): void {
  toastTimers.set(id, { t: window.setTimeout(() => dismissToast(id), left), due: Date.now() + left, left });
}
function pauseToast(id: number): void {
  const r = toastTimers.get(id);
  if (!r) return;
  clearTimeout(r.t);
  r.left = Math.max(600, r.due - Date.now());
}
function resumeToast(id: number): void {
  const r = toastTimers.get(id);
  if (r) armToast(id, r.left);
}
function dismissToast(id: number): void {
  const r = toastTimers.get(id);
  if (r) clearTimeout(r.t);
  toastTimers.delete(id);
  toastStore.set(toastStore.get().map((x) => (x.id === id ? { ...x, leaving: true } : x)));
  setTimeout(() => toastStore.set(toastStore.get().filter((x) => x.id !== id)), 160);
}
export function toast(msg: string, opts: ToastOpts = {}): { dismiss: () => void } {
  const id = ++toastSeq;
  toastStore.set([...toastStore.get(), { id, msg, tone: opts.tone ?? "ok", action: opts.action }]);
  armToast(id, opts.ms ?? (opts.action ? 7000 : 2600));
  return { dismiss: () => dismissToast(id) };
}

// ---- upload progress tray --------------------------------------------------
// A floating bottom-right list of in-flight uploads (every entry point — drop,
// paste, slash picker, annotate save — registers here). Detailed % lives here;
// the document shows only a lightweight skeleton block at the insertion point.
export type UploadItem = { id: number; name: string; loaded: number; total: number; failed?: boolean; retry?: () => void };
const uploadStore = makeStore<UploadItem[]>([]);
let uploadSeq = 0;
function patchUpload(id: number, patch: Partial<UploadItem>) {
  uploadStore.set(uploadStore.get().map((u) => (u.id === id ? { ...u, ...patch } : u)));
}
function dropUpload(id: number) {
  uploadStore.set(uploadStore.get().filter((u) => u.id !== id));
}
export function startUpload(name: string): number {
  const id = ++uploadSeq;
  uploadStore.set([...uploadStore.get(), { id, name, loaded: 0, total: 0 }]);
  return id;
}
export function updateUpload(id: number, loaded: number, total: number) {
  patchUpload(id, { loaded, total });
}
/** Mark an upload done. ok → fade out shortly; failed → linger (red) with a
 *  retry button if `retry` is given, until the user retries or dismisses. */
export function finishUpload(id: number, ok: boolean, retry?: () => void) {
  if (ok) {
    patchUpload(id, { loaded: 1, total: 1 });
    setTimeout(() => dropUpload(id), 900);
  } else {
    patchUpload(id, { failed: true, retry });
  }
}

function UploadTray() {
  const items = uploadStore.use();
  if (!items.length) return null;
  return (
    <div class="upload-tray">
      {items.map((u) => {
        const pct = u.failed ? null : u.total > 0 ? Math.min(100, Math.round((u.loaded / u.total) * 100)) : null;
        return (
          <div key={u.id} class={"upload-item" + (u.failed ? " failed" : "")}>
            <span class="up-name" title={u.name}>{u.name}</span>
            {u.failed ? (
              <span class="up-fail">
                <span>{t("失败")}</span>
                {u.retry && (
                  <button class="up-retry" onClick={() => { u.retry?.(); dropUpload(u.id); }}>{t("重试")}</button>
                )}
                <button class="up-x" title={t("移除")} onClick={() => dropUpload(u.id)}><Icon name="x" cls="ico sm" /></button>
              </span>
            ) : (
              <span class="up-prog">
                <span class={"ver-bar" + (pct == null ? " indet" : "")}>
                  <span class="ver-bar-fill" style={pct != null ? { width: `${pct}%` } : undefined} />
                </span>
                <span class="up-pct">{pct != null ? `${pct}%` : "…"}</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- menu / popover --------------------------------------------------------
export type MenuAnchor = { x: number; y: number } | { rect: DOMRect } | MouseEvent | HTMLElement;
type ResolvedAnchor = { x: number; y: number } | { rect: DOMRect };
type MenuState = {
  render: (close: () => void) => ComponentChildren;
  anchor: ResolvedAnchor;
  minWidth?: number;
  kb: boolean;
  restore: HTMLElement | null;
} | null;
const menuStore = makeStore<MenuState>(null);
export function openMenu(
  anchor: MenuAnchor,
  render: (close: () => void) => ComponentChildren,
  opts: { minWidth?: number } = {},
) {
  let a: ResolvedAnchor;
  let kb = false;
  if (anchor instanceof HTMLElement) {
    a = { rect: anchor.getBoundingClientRect() };
    kb = true;
  } else if (anchor instanceof MouseEvent) {
    kb = anchor.detail === 0 && anchor.clientX === 0 && anchor.clientY === 0;
    const el = (anchor.currentTarget ?? anchor.target) as HTMLElement | null;
    a = kb && el?.getBoundingClientRect ? { rect: el.getBoundingClientRect() } : { x: anchor.clientX, y: anchor.clientY };
  } else a = anchor;
  menuStore.set({ render, anchor: a, minWidth: opts.minWidth, kb, restore: document.activeElement as HTMLElement | null });
}
export function closeMenu() {
  menuStore.set(null);
}

function anchorPoint(a: ResolvedAnchor): { x: number; y: number } {
  if ("rect" in a) return { x: a.rect.left, y: a.rect.bottom };
  return { x: a.x, y: a.y };
}

const ROVING_KEYS = /^(ArrowDown|ArrowUp|Home|End)$/;

function MenuHost() {
  const state = menuStore.use();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Phone: an anchored popover under a finger is cramped and clips at screen
  // edges — pin these discrete menus to the bottom as an action sheet instead.
  // The editor's slash menu / format bar render their own .pop and stay
  // caret-anchored on purpose. Read per open; menus never survive a rotation.
  const sheet = matchMedia(MOBILE_MQ).matches;
  // Escape closes the open menu (capture phase: the menu is the topmost layer);
  // ↑↓/Home/End move real focus between items unless an inner input owns keys.
  useEffect(() => {
    if (!state) return;
    const on = (e: KeyboardEvent) => {
      if (imeGhost(e)) return;
      if (e.key === "Escape") {
        if (modalStore.get()?.aboveMenus) return;
        consumeKey(e);
        closeMenu();
        return;
      }
      if (!ROVING_KEYS.test(e.key) || isEditableTarget(e.target)) return;
      const pop = ref.current;
      if (!pop) return;
      const items = Array.from(pop.querySelectorAll<HTMLButtonElement>("button.item:not(:disabled)"));
      if (!items.length) return;
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "ArrowDown" ? (cur + 1) % items.length
        : e.key === "ArrowUp" ? (cur - 1 + items.length) % items.length
        : e.key === "Home" ? 0 : items.length - 1;
      consumeKey(e);
      items[next]!.focus();
    };
    window.addEventListener("keydown", on, true);
    return () => {
      window.removeEventListener("keydown", on, true);
      if (state.restore?.isConnected) state.restore.focus();
    };
  }, [state]);
  useLayoutEffect(() => {
    if (!state || !ref.current || sheet) return setPos(null);
    const { x, y } = anchorPoint(state.anchor);
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(x, innerWidth - r.width - 10),
      top: Math.min(y + 4, innerHeight - r.height - 10),
    });
    if (state.kb) ref.current.querySelector<HTMLElement>("button.item, input")?.focus();
  }, [state, sheet]);
  if (!state) return null;
  return (
    <div class="menu-layer" onMouseDown={(e) => e.target === e.currentTarget && closeMenu()}>
      <div
        ref={ref}
        class={"pop" + (sheet ? " sheet" : "")}
        style={sheet ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth: state.minWidth }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {state.render(closeMenu)}
      </div>
    </div>
  );
}

// ---- tooltip (elements carrying data-tip / data-tip-kbd, see shortcuts.ts tip()) ----
type TipState = { el: HTMLElement; label: string; kbdId: string | null } | null;
const tipStore = makeStore<TipState>(null);
const TIP_MQ = "(hover: hover) and (pointer: fine)";
const TIP_DELAY = 450;
const TIP_WARM = 300;

function TooltipHost() {
  const state = tipStore.use();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: "below" | "above" } | null>(null);

  useEffect(() => {
    if (!matchMedia(TIP_MQ).matches) return;
    let timer = 0;
    let lastHide = 0;
    let current: HTMLElement | null = null;
    const read = (el: HTMLElement): TipState => ({ el, label: el.dataset.tip ?? "", kbdId: el.dataset.tipKbd ?? null });
    const hide = () => {
      clearTimeout(timer);
      timer = 0;
      current = null;
      if (tipStore.get()) {
        lastHide = Date.now();
        tipStore.set(null);
      }
    };
    const arm = (el: HTMLElement) => {
      if (el === current) return;
      current = el;
      clearTimeout(timer);
      if (tipStore.get() || Date.now() - lastHide < TIP_WARM) {
        tipStore.set(read(el));
        return;
      }
      timer = window.setTimeout(() => {
        if (current === el && el.isConnected) tipStore.set(read(el));
      }, TIP_DELAY);
    };
    const targetOf = (t: EventTarget | null) =>
      (t as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
    const over = (e: PointerEvent) => {
      const el = targetOf(e.target);
      if (!el || (el as HTMLButtonElement).disabled) {
        if (current) hide();
        return;
      }
      arm(el);
    };
    const out = (e: PointerEvent) => {
      if (!current) return;
      const to = e.relatedTarget as Node | null;
      if (to && current.contains(to)) return;
      hide();
    };
    const focusIn = (e: FocusEvent) => {
      const el = targetOf(e.target);
      if (el && el.matches(":focus-visible")) arm(el);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!state || !ref.current) return setPos(null);
    const a = state.el.getBoundingClientRect();
    const box = ref.current.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    let top = a.bottom + gap;
    let side: "below" | "above" = "below";
    if (top + box.height > innerHeight - margin) {
      top = a.top - gap - box.height;
      side = "above";
    }
    const left = Math.max(margin, Math.min(a.left + a.width / 2 - box.width / 2, innerWidth - box.width - margin));
    setPos({ left, top, side });
  }, [state]);

  if (!state) return null;
  return (
    <div
      ref={ref}
      class="tip"
      role="tooltip"
      data-side={pos?.side ?? "below"}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      <span class="tip-label">{state.label}</span>
      {state.kbdId && <Kbd id={state.kbdId} />}
    </div>
  );
}

export function MenuLabel({ children }: { children: ComponentChildren }) {
  return <div class="lbl">{children}</div>;
}
export function MenuSep() {
  return <div class="sep" />;
}
export function MenuItem({
  icon,
  label,
  sublabel,
  sub = "stack",
  shortcut,
  danger,
  checked,
  sel,
  onHover,
  onClick,
}: {
  icon?: string;
  label: ComponentChildren;
  sublabel?: ComponentChildren;
  /** Sublabel placement: stacked under the title, or right-aligned muted text. */
  sub?: "stack" | "right";
  /** Shortcut id (shortcuts.ts) rendered as a key-cap badge when available on this platform. */
  shortcut?: string;
  danger?: boolean;
  checked?: boolean;
  /** keyboard-navigation highlight (search-driven lists); the selected row shows ↵ */
  sel?: boolean;
  onHover?: () => void;
  onClick: () => void;
}) {
  const managed = sel !== undefined;
  return (
    <button
      class={"item" + (danger ? " danger" : "") + (sel ? " sel" : "") + (sub === "right" ? " sub-r" : "")}
      onClick={onClick}
      onMouseEnter={onHover}
    >
      {icon && (
        <span class="lico plain">
          <Icon name={icon} cls="ico sm" />
        </span>
      )}
      <span class="meta">
        <span class="t">{label}</span>
        {sublabel && <span class="d">{sublabel}</span>}
      </span>
      {shortcut && shortcutAvailable(shortcut) && <Kbd id={shortcut} />}
      {checked && (
        <span class="chk">
          <Icon name="check" cls="ico sm" />
        </span>
      )}
      {managed && !checked && <ReturnHint />}
    </button>
  );
}

/** ↵ glyph shown on the keyboard-selected row of a search-driven list. */
export function ReturnHint() {
  return (
    <span class="ret" aria-hidden="true">
      <kbd class="kbd"><span class="key sym">↵</span></kbd>
    </span>
  );
}

// ---- drawer transition -----------------------------------------------------
// Slide-in/out for the right-side peek drawers. The drawer is conditionally
// mounted by its parent, so to play the CSS transition we mount with open=false
// (translateX(100%)) and flip to true on the next frame; on close we slide out
// first, then let the parent unmount after the animation finishes.
export function useDrawerTransition(onClose: () => void, durationMs = 240, opts: { esc?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const close = () => {
    setOpen(false);
    setTimeout(onClose, durationMs);
  };
  useEscape(close, opts.esc ?? true);
  return { open, close };
}

const escStack: symbol[] = [];
/** Escape closes the topmost drawer; menus and modals above it win, and inner
 *  editable fields keep their own Escape. */
export function useEscape(onEsc: () => void, enabled = true) {
  const cb = useRef(onEsc);
  cb.current = onEsc;
  useEffect(() => {
    if (!enabled) return;
    const me = Symbol();
    escStack.push(me);
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || imeGhost(e)) return;
      if (menuStore.get() || modalStore.get()) return;
      if (escStack[escStack.length - 1] !== me) return;
      if (isEditableTarget(e.target)) return;
      consumeKey(e);
      cb.current();
    };
    window.addEventListener("keydown", on, true);
    return () => {
      window.removeEventListener("keydown", on, true);
      escStack.splice(escStack.indexOf(me), 1);
    };
  }, [enabled]);
}

/** Drag-to-resize for right-anchored drawers (.peek): render `handle` as the
 *  drawer's first child and put `width` on its style. Width persists per
 *  `storageKey`; null means "stylesheet default". Double-click resets. The
 *  drawer is right-anchored, so width = viewport right edge − pointer x. */
export function useDrawerResize(storageKey: string, min = 380) {
  const [width, setWidth] = useState<number | null>(() => {
    const v = Number(localStorage.getItem(storageKey) || "");
    return Number.isFinite(v) && v >= min ? v : null;
  });
  const start = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let w: number | null = null;
    const move = (ev: PointerEvent) => {
      w = Math.max(min, Math.min(window.innerWidth - 64, window.innerWidth - ev.clientX));
      setWidth(w);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (w != null) localStorage.setItem(storageKey, String(Math.round(w)));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const reset = () => {
    localStorage.removeItem(storageKey);
    setWidth(null);
  };
  const handle = (
    <div
      class="peek-resize"
      title={t("拖动调整宽度，双击复原")}
      onPointerDown={start}
      onDblClick={reset}
    />
  );
  return { width, handle };
}

// ---- modal -----------------------------------------------------------------
// aboveMenus raises this one modal's scrim over the menu layer (115) so a
// dialog can stack on top of an open popover without dismissing it. Off by
// default: some modals (blob manager) open menus of their own and rely on the
// menu layer sitting above the scrim.
type ModalState = { node: VNode; aboveMenus?: boolean; closing?: boolean } | null;
const modalStore = makeStore<ModalState>(null);
let modalCloseTimer = 0;
export function openModal(node: VNode, opts: { aboveMenus?: boolean } = {}) {
  clearTimeout(modalCloseTimer);
  modalStore.set({ node, aboveMenus: opts.aboveMenus });
}
export function closeModal() {
  const s = modalStore.get();
  if (!s || s.closing) return;
  modalStore.set({ ...s, closing: true });
  modalCloseTimer = window.setTimeout(() => {
    if (modalStore.get()?.closing) modalStore.set(null);
  }, 120);
}

export function Modal({
  title,
  sub,
  children,
  footer,
  hint,
  onEnter,
  width,
}: {
  title: string;
  sub?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  /** Key hints rendered at the left of the footer (e.g. ↵ 确定 · Esc 取消). */
  hint?: ComponentChildren;
  /** Enter anywhere in the dialog (outside buttons / textareas) confirms. */
  onEnter?: () => void;
  width?: number;
}) {
  return (
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{ width }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={onEnter ? (e) => {
        if (e.key !== "Enter" || e.defaultPrevented || imeGhost(e)) return;
        const el = e.target as HTMLElement;
        if (el.tagName === "BUTTON" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
        consumeKey(e);
        onEnter();
      } : undefined}
    >
      <div class="modal-head">
        <h3>{title}</h3>
        {sub && <p>{sub}</p>}
      </div>
      <div class="modal-body">{children}</div>
      {(footer || hint) && (
        <div class="modal-foot">
          {hint && <span class="modal-hint">{hint}</span>}
          {footer}
        </div>
      )}
    </div>
  );
}

/** Footer hint for confirm-style dialogs: ↵ <confirm> · Esc 取消. */
export function EnterEscHint({ confirm }: { confirm: string }) {
  return (
    <>
      <Kbd combo={{ key: "Enter" }} /> {confirm}
      <Kbd combo={{ key: "Escape" }} /> {t("取消")}
    </>
  );
}

const MODAL_FOCUS = ["[autofocus]", "input:not([type=checkbox]):not([type=hidden])", "textarea", ".btn-danger", ".btn-primary", "button"];
function focusFirst(root: HTMLElement | null): void {
  if (!root) return;
  for (const sel of MODAL_FOCUS) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) {
      el.focus();
      return;
    }
  }
}

function ModalHost() {
  const state = modalStore.use();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state || state.closing) return;
    const restore = document.activeElement as HTMLElement | null;
    focusFirst(host.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || imeGhost(e)) return;
      if (menuStore.get() && !state.aboveMenus) return;
      consumeKey(e);
      closeModal();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (restore?.isConnected) restore.focus();
    };
  }, [state?.node]);
  return (
    <div
      ref={host}
      class={
        "modal-scrim" +
        (state && !state.closing ? " open" : "") +
        (state?.closing ? " closing" : "") +
        (state?.aboveMenus ? " above-menus" : "")
      }
      onMouseDown={(e) => e.target === e.currentTarget && closeModal()}
    >
      {state?.node}
    </div>
  );
}

/** Promise-based confirm dialog. Resolves true on confirm, false otherwise. */
export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Stack this dialog above an open popover menu instead of under it. */
  aboveMenus?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      closeModal();
      resolve(v);
    };
    openModal(
      <Modal
        title={opts.title}
        onEnter={() => done(true)}
        hint={<EnterEscHint confirm={opts.confirmLabel ?? t("确定")} />}
        footer={
          <>
            <button class="btn btn-secondary" onClick={() => done(false)}>
              {t("取消")}
            </button>
            <button
              class={"btn " + (opts.danger ? "btn-danger" : "btn-primary")}
              autofocus
              onClick={() => done(true)}
            >
              {opts.confirmLabel ?? t("确定")}
            </button>
          </>
        }
      >
        {/* pre-line so multi-line consequence lists (\n) render as lists */}
        <div class="muted cfm-msg">{opts.message}</div>
      </Modal>,
      { aboveMenus: opts.aboveMenus },
    );
  });
}

/** Promise-based single-field prompt. Resolves the trimmed value, or null. */
export function promptDialog(opts: {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let val = opts.value ?? "";
    const done = (v: string | null) => {
      closeModal();
      resolve(v);
    };
    openModal(
      <Modal
        title={opts.title}
        onEnter={() => done(val.trim() || (opts.value ?? ""))}
        hint={<EnterEscHint confirm={opts.confirmLabel ?? t("保存")} />}
        footer={
          <>
            <button class="btn btn-secondary" onClick={() => done(null)}>
              {t("取消")}
            </button>
            <button class="btn btn-primary" onClick={() => done(val.trim() || (opts.value ?? ""))}>
              {opts.confirmLabel ?? t("保存")}
            </button>
          </>
        }
      >
        {opts.label && <div class="field-label">{opts.label}</div>}
        <input
          class="text-input"
          ref={(el) => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
          value={opts.value ?? ""}
          placeholder={opts.placeholder}
          onInput={(e) => (val = (e.target as HTMLInputElement).value)}
        />
      </Modal>,
    );
  });
}

/** Dismissible inline error strip. */
export function ErrorBar({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div class="error-bar" role="alert">
      <Icon name="alert" cls="ico sm" />
      <span class="error-msg">{msg}</span>
      <button class="error-x" title={t("关闭")} onClick={onClose}>
        <Icon name="x" cls="ico sm" />
      </button>
    </div>
  );
}

/** Wrap `span` of `text` in <mark>. */
export function Highlight({ text, span }: { text: string; span?: [number, number] }) {
  if (!span || span[1] <= 0) return <>{text}</>;
  const [s, n] = span;
  return (
    <>
      {text.slice(0, s)}
      <mark>{text.slice(s, s + n)}</mark>
      {text.slice(s + n)}
    </>
  );
}

/** FTS snippets are plain text with `[..]` wrapping each matched term (see
 *  core/search.ts). Render them as text nodes with <mark> around the wrapped
 *  spans — never as HTML, so document content can't inject markup. */
export function SnippetText({ text }: { text: string }) {
  const parts = text.split(/\[([^\[\]]*)\]/g);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

/** The single mount point for all imperative UI. Place once at app root. */
export function UiHost() {
  const toasts = toastStore.use();
  return (
    <>
      <MenuHost />
      <ModalHost />
      <TooltipHost />
      <div class="toasts">
        {toasts.map((item) => (
          <div
            key={item.id}
            class={"toast " + item.tone + (item.leaving ? " leaving" : "")}
            onMouseEnter={() => pauseToast(item.id)}
            onMouseLeave={() => resumeToast(item.id)}
          >
            <Icon name={item.tone === "error" ? "alert" : "check"} cls="ico sm" />
            <span class="toast-msg">{item.msg}</span>
            {item.action && (
              <button class="toast-act" onClick={() => { void item.action!.run(); dismissToast(item.id); }}>
                {item.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
      <UploadTray />
    </>
  );
}
