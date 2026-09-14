/** @jsxImportSource preact */
import { PageHeader, SetRow, SetSection } from "./primitives.tsx";
import { pageLabel } from "./nav.ts";
import { IS_DESKTOP_APP, SHORTCUTS, SHORTCUT_GROUPS } from "../shortcuts.ts";
import { Kbd } from "../kbd.tsx";

export function ShortcutsPage() {
  return (
    <>
      <PageHeader
        title={pageLabel("shortcuts")}
        sub={IS_DESKTOP_APP ? undefined : "标注「仅桌面应用」的组合键被浏览器保留，只在桌面应用里可用。"}
      />
      {SHORTCUT_GROUPS.map((g) => {
        const rows = SHORTCUTS.filter((s) => s.group === g.key && (g.key !== "quicknote" || IS_DESKTOP_APP));
        if (rows.length === 0) return null;
        return (
          <SetSection key={g.key} label={g.label}>
            {rows.map((s) => {
              const unavailable = !!s.desktopOnly && !IS_DESKTOP_APP;
              return (
                <SetRow
                  key={s.id}
                  title={s.label}
                  caption={unavailable ? "仅桌面应用" : undefined}
                  dim={unavailable}
                  control={<Kbd id={s.id} />}
                />
              );
            })}
          </SetSection>
        );
      })}
    </>
  );
}
