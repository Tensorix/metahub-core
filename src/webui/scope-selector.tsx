/** @jsxImportSource preact */
// Productized scope picker shared by every storage/sync/share surface. It is a
// pure projection of scopesFor(clientMode()): it NEVER re-routes topology, only
// picks among scopes that physically exist. Three honest render modes:
//   0 scopes → nothing
//   1 scope  → a read-only pill (no fake choice — the scope is just shown)
//   >1       → a segmented control (few short options) or a menu (many/long)
// Visuals reuse the existing design system (.theme-card / .peer-tag tokens).

import type { VNode } from "preact";
import { Icon } from "./icons.tsx";
import { openMenu, MenuItem } from "./ui.tsx";
import type { Scope } from "./data/scopes.ts";

export function ScopeSelector({
  scopes,
  value,
  onChange,
  variant,
  sub,
}: {
  scopes: Scope[];
  value: string;
  onChange: (id: string) => void;
  /** Force a presentation; defaults to segmented for ≤3, menu for more. */
  variant?: "segmented" | "menu";
  /** Show the selected scope's subtitle line under the control. */
  sub?: boolean;
}): VNode | null {
  if (scopes.length === 0) return null;
  const sel = scopes.find((s) => s.id === value) ?? scopes[0]!;
  const subline = sub && sel.subtitle ? <div class="scope-sub">{sel.subtitle}</div> : null;

  // Single scope: honest read-only pill, never a disabled-looking control.
  if (scopes.length === 1) {
    return (
      <div class="scope-pick">
        <span class="scope-pill">
          <Icon name={sel.icon} />
          {sel.label}
        </span>
        {subline}
      </div>
    );
  }

  const mode = variant ?? (scopes.length > 3 ? "menu" : "segmented");

  if (mode === "menu") {
    return (
      <div class="scope-pick">
        <button
          class="btn btn-secondary scope-trigger"
          onClick={(e) =>
            openMenu(e, (close) =>
              scopes.map((s) => (
                <MenuItem
                  key={s.id}
                  icon={s.icon}
                  label={s.label}
                  sublabel={s.subtitle}
                  checked={s.id === sel.id}
                  onClick={() => {
                    onChange(s.id);
                    close();
                  }}
                />
              )),
            )
          }
        >
          <Icon name={sel.icon} />
          {sel.label}
          <Icon name="chevronDown" cls="ico sm" />
        </button>
        {subline}
      </div>
    );
  }

  return (
    <div class="scope-pick">
      <div class="scope-seg" role="tablist">
        {scopes.map((s) => (
          <button
            key={s.id}
            class={"scope-seg-item" + (s.id === sel.id ? " sel" : "")}
            role="tab"
            aria-selected={s.id === sel.id}
            onClick={() => onChange(s.id)}
          >
            <Icon name={s.icon} />
            {s.label}
          </button>
        ))}
      </div>
      {subline}
    </div>
  );
}
