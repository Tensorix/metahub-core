/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { getTheme, setTheme, type ThemeChoice } from "./theme.ts";

const THEMES: { value: ThemeChoice; icon: string; name: string; desc: string }[] = [
  { value: "light", icon: "sun", name: "浅色", desc: "始终使用明亮界面" },
  { value: "dark", icon: "moon", name: "深色", desc: "始终使用暗色界面" },
  { value: "system", icon: "monitor", name: "跟随系统", desc: "随操作系统外观自动切换" },
];

export function SettingsView() {
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());

  const pick = (t: ThemeChoice) => {
    setTheme(t);
    setThemeState(t);
  };

  return (
    <div class="set-page">
      <div class="set-title">设置</div>
      <div class="set-sub">个性化你的 Metahub 工作区。</div>

      <div class="set-section">
        <div class="set-section-head">外观</div>
        <div class="set-section-desc">选择界面的颜色主题。</div>
        <div class="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.value}
              class={"theme-card" + (theme === t.value ? " sel" : "")}
              aria-pressed={theme === t.value}
              onClick={() => pick(t.value)}
            >
              <span class="tc-check"><Icon name="check" /></span>
              <span class="tc-ico"><Icon name={t.icon} /></span>
              <span class="tc-name">{t.name}</span>
              <span class="tc-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
