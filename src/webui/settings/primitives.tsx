/** @jsxImportSource preact */
// Flat, Notion-style settings primitives for the page-per-section surface:
// rows with a right-aligned control slot, flat labelled sections, page chrome
// and a danger zone. Purely presentational — pages compose these; no data
// logic lives here. CSS: .set-row* / .set-section* / .page-header* /
// .danger-zone* in styles.css, next to the existing settings styles.
import type { ComponentChildren } from "preact";
import { Icon } from "../icons.tsx";
import { openMenu, MenuItem } from "../ui.tsx";

/** One setting: bold 14px title + one-line muted caption on the left, the
 *  control right-aligned. `children` render an expandable detail area below
 *  the 44px row line. Adjacent rows are hairline-divided by CSS. */
export function SetRow({
  title,
  caption,
  control,
  disabled,
  danger,
  onClick,
  children,
}: {
  title: ComponentChildren;
  caption?: ComponentChildren;
  control?: ComponentChildren;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children?: ComponentChildren;
}) {
  return (
    <div
      class={
        "set-row" +
        (disabled ? " disabled" : "") +
        (danger ? " danger" : "") +
        (onClick ? " clickable" : "")
      }
    >
      <div class="set-row-line" onClick={disabled ? undefined : onClick}>
        <div class="set-row-text">
          <div class="set-row-title">{title}</div>
          {caption != null && <div class="set-row-caption">{caption}</div>}
        </div>
        {control != null && <div class="set-row-control">{control}</div>}
      </div>
      {children != null && <div class="set-row-detail">{children}</div>}
    </div>
  );
}

/** THE switch — the existing button-based .switch/.switch-knob pattern.
 *  `locked` renders it checked + disabled without dimming (a state the user
 *  can't change here, not a broken control). */
export function Switch({
  checked,
  onChange,
  disabled,
  locked,
}: {
  checked: boolean;
  onChange?: (on: boolean) => void;
  disabled?: boolean;
  locked?: boolean;
}) {
  const on = locked || checked;
  return (
    <button
      class={"switch" + (on ? " on" : "") + (locked ? " locked" : "")}
      role="switch"
      aria-checked={on}
      disabled={disabled || locked}
      onClick={() => onChange?.(!checked)}
    >
      <span class="switch-knob" />
    </button>
  );
}

/** Flat section: a small gray label over its rows — no gray panel box. The
 *  optional caption states a property of the whole section (typically WHERE the
 *  managed thing lives — its storage scope), distinct from `.set-managed-note`
 *  mid/tail annotations. */
export function SetSection({ label, caption, children }: {
  label: ComponentChildren;
  caption?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="set-section">
      <div class="set-section-label">{label}</div>
      {caption != null && <div class="set-section-caption">{caption}</div>}
      {children}
    </section>
  );
}

/** Page title row with an optional right-aligned primary action, an optional
 *  sub line and an optional banner slot below (status callouts etc.). */
export function PageHeader({
  title,
  sub,
  banner,
  action,
}: {
  title: ComponentChildren;
  sub?: ComponentChildren;
  banner?: ComponentChildren;
  action?: ComponentChildren;
}) {
  return (
    <header class="page-header">
      <div class="page-header-row">
        <div class="page-header-text">
          <h1 class="page-header-title">{title}</h1>
          {sub != null && <div class="page-header-sub">{sub}</div>}
        </div>
        {action != null && <div class="page-header-action">{action}</div>}
      </div>
      {banner != null && <div class="page-header-banner">{banner}</div>}
    </header>
  );
}

/** Bottom-of-page destructive section; put `danger` SetRows inside. */
export function DangerZone({ children }: { children: ComponentChildren }) {
  return (
    <section class="danger-zone">
      <div class="danger-zone-label">危险操作</div>
      {children}
    </section>
  );
}

/** Trailing `⋯` button opening a row's overflow menu (ui.tsx openMenu). */
export function RowMenu({
  items,
}: {
  items: { icon?: string; label: ComponentChildren; sublabel?: string; danger?: boolean; onClick: () => void }[];
}) {
  return (
    <button
      class="btn btn-ghost peer-menu"
      title="更多"
      onClick={(e) =>
        openMenu(e as unknown as MouseEvent, (close) => (
          <>
            {items.map((it) => (
              <MenuItem
                icon={it.icon}
                label={it.label}
                sublabel={it.sublabel}
                danger={it.danger}
                onClick={() => {
                  close();
                  it.onClick();
                }}
              />
            ))}
          </>
        ))
      }
    >
      <Icon name="dots" cls="ico sm" />
    </button>
  );
}
