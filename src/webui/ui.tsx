/** @jsxImportSource preact */
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";

// Imperative UI primitives (Toast / Menu / Modal) backed by tiny external
// stores, so any code can pop a menu or dialog without prop-drilling. Mount
// <UiHost/> once at the app root. Replaces native alert/prompt/confirm.

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
type Toast = { id: number; msg: string };
const toastStore = makeStore<Toast[]>([]);
let toastSeq = 0;
export function toast(msg: string) {
  const id = ++toastSeq;
  toastStore.set([...toastStore.get(), { id, msg }]);
  setTimeout(() => toastStore.set(toastStore.get().filter((t) => t.id !== id)), 2600);
}

// ---- menu / popover --------------------------------------------------------
export type MenuAnchor = { x: number; y: number } | { rect: DOMRect } | MouseEvent;
type MenuState = { render: (close: () => void) => ComponentChildren; anchor: MenuAnchor; minWidth?: number } | null;
const menuStore = makeStore<MenuState>(null);
export function openMenu(
  anchor: MenuAnchor,
  render: (close: () => void) => ComponentChildren,
  opts: { minWidth?: number } = {},
) {
  menuStore.set({ render, anchor, minWidth: opts.minWidth });
}
export function closeMenu() {
  menuStore.set(null);
}

function anchorPoint(a: MenuAnchor): { x: number; y: number; bottom?: number } {
  if (a instanceof MouseEvent) return { x: a.clientX, y: a.clientY };
  if ("rect" in a) return { x: a.rect.left, y: a.rect.bottom, bottom: a.rect.bottom };
  return { x: a.x, y: a.y };
}

function MenuHost() {
  const state = menuStore.use();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!state || !ref.current) return setPos(null);
    const { x, y } = anchorPoint(state.anchor);
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(x, innerWidth - r.width - 10),
      top: Math.min(y + 4, innerHeight - r.height - 10),
    });
  }, [state]);
  if (!state) return null;
  return (
    <div class="menu-layer" onMouseDown={(e) => e.target === e.currentTarget && closeMenu()}>
      <div
        ref={ref}
        class="pop"
        style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth: state.minWidth }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {state.render(closeMenu)}
      </div>
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
  danger,
  checked,
  onClick,
}: {
  icon?: string;
  label: ComponentChildren;
  sublabel?: string;
  danger?: boolean;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <button class={"item" + (danger ? " danger" : "")} onClick={onClick}>
      {icon && (
        <span class="lico plain">
          <Icon name={icon} cls="ico sm" />
        </span>
      )}
      <span class="meta">
        <span class="t">{label}</span>
        {sublabel && <span class="d">{sublabel}</span>}
      </span>
      {checked && (
        <span class="chk">
          <Icon name="check" cls="ico sm" />
        </span>
      )}
    </button>
  );
}

// ---- drawer transition -----------------------------------------------------
// Slide-in/out for the right-side peek drawers. The drawer is conditionally
// mounted by its parent, so to play the CSS transition we mount with open=false
// (translateX(100%)) and flip to true on the next frame; on close we slide out
// first, then let the parent unmount after the animation finishes.
export function useDrawerTransition(onClose: () => void, durationMs = 240) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const close = () => {
    setOpen(false);
    setTimeout(onClose, durationMs);
  };
  return { open, close };
}

// ---- modal -----------------------------------------------------------------
const modalStore = makeStore<VNode | null>(null);
export function openModal(node: VNode) {
  modalStore.set(node);
}
export function closeModal() {
  modalStore.set(null);
}

export function Modal({
  title,
  sub,
  children,
  footer,
  width,
}: {
  title: string;
  sub?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  width?: number;
}) {
  return (
    <div class="modal" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <h3>{title}</h3>
        {sub && <p>{sub}</p>}
      </div>
      <div class="modal-body">{children}</div>
      {footer && <div class="modal-foot">{footer}</div>}
    </div>
  );
}

function ModalHost() {
  const node = modalStore.use();
  useEffect(() => {
    if (!node) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeModal();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [node]);
  return (
    <div
      class={"modal-scrim" + (node ? " open" : "")}
      onMouseDown={(e) => e.target === e.currentTarget && closeModal()}
    >
      {node}
    </div>
  );
}

/** Promise-based confirm dialog. Resolves true on confirm, false otherwise. */
export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      closeModal();
      resolve(v);
    };
    openModal(
      <Modal
        title={opts.title}
        footer={
          <>
            <button class="btn btn-secondary" onClick={() => done(false)}>
              取消
            </button>
            <button
              class={"btn " + (opts.danger ? "btn-danger" : "btn-primary")}
              onClick={() => done(true)}
            >
              {opts.confirmLabel ?? "确定"}
            </button>
          </>
        }
      >
        <div class="muted">{opts.message}</div>
      </Modal>,
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
        footer={
          <>
            <button class="btn btn-secondary" onClick={() => done(null)}>
              取消
            </button>
            <button class="btn btn-primary" onClick={() => done(val.trim() || (opts.value ?? ""))}>
              {opts.confirmLabel ?? "保存"}
            </button>
          </>
        }
      >
        {opts.label && <div class="field-label">{opts.label}</div>}
        <input
          class="text-input"
          autofocus
          value={opts.value ?? ""}
          placeholder={opts.placeholder}
          onInput={(e) => (val = (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") done(val.trim() || (opts.value ?? ""));
          }}
        />
      </Modal>,
    );
  });
}

/** The single mount point for all imperative UI. Place once at app root. */
export function UiHost() {
  const toasts = toastStore.use();
  return (
    <>
      <MenuHost />
      <ModalHost />
      <div class="toasts">
        {toasts.map((t) => (
          <div key={t.id} class="toast">
            <Icon name="check" cls="ico sm" />
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </>
  );
}
