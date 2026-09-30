import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Locale = "zh-CN" | "en";
type Params = Record<string, string | number>;

const EN = {
  文件: "File",
  "按 ID 打开…": "Open by ID…",
  命令面板: "Command Palette",
  快速笔记: "Quick Note",
  快速看板: "Quick Board",
  "退出 Metahub": "Quit Metahub",
  "关于 Metahub": "About Metahub",
  服务: "Services",
  "隐藏 Metahub": "Hide Metahub",
  隐藏其他: "Hide Others",
  显示全部: "Show All",
  关闭窗口: "Close Window",
  编辑: "Edit",
  撤销: "Undo",
  重做: "Redo",
  剪切: "Cut",
  复制: "Copy",
  粘贴: "Paste",
  粘贴并匹配样式: "Paste and Match Style",
  删除: "Delete",
  全选: "Select All",
  显示: "View",
  重新加载: "Reload",
  强制重新加载: "Force Reload",
  开发者工具: "Toggle Developer Tools",
  实际大小: "Actual Size",
  放大: "Zoom In",
  缩小: "Zoom Out",
  切换全屏: "Toggle Full Screen",
  窗口: "Window",
  最小化: "Minimize",
  缩放: "Zoom",
  全部置于顶层: "Bring All to Front",
  图片预览: "Image preview",
  保存: "Save",
  不保存: "Don't Save",
  取消: "Cancel",
  确定: "OK",
  "是否保存对「{name}」的更改？": "Save changes to “{name}”?",
  "不保存将丢弃自上次保存以来的更改。": "Your changes since the last save will be lost if you don't save.",
  "无法保存「{name}」": "Could not save “{name}”",
  "保存未在限定时间内完成，文件未写入磁盘。": "The save did not finish in time; the file was not written to disk.",
  "Metahub 服务未启动": "Metahub service is not running",
  "此窗口需要后台服务，但它未能启动：\n{msg}\n\n文件编辑窗口不受影响；可从托盘菜单退出后重新启动 Metahub。":
    "This window needs the background service, but it failed to start:\n{msg}\n\nFile editor windows are unaffected; quit from the tray menu and relaunch Metahub.",
  未知错误: "Unknown error",
  "快捷键「{accel}」已被「{title}」占用": "Shortcut “{accel}” is already used by “{title}”",
  "快捷键「{accel}」无法注册（可能被占用）": "Shortcut “{accel}” could not be registered (it may be in use)",
} as const;

export type MsgKey = keyof typeof EN;

const isLocale = (v: unknown): v is Locale => v === "zh-CN" || v === "en";

function settingsPath(): string {
  return join(app.getPath("userData"), "app-settings.json");
}

let current: Locale | null = null;

function fromSystem(): Locale {
  return /^zh\b/i.test(app.getLocale()) ? "zh-CN" : "en";
}

export function getLocale(): Locale {
  if (current) return current;
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as { locale?: unknown };
    current = isLocale(raw.locale) ? raw.locale : fromSystem();
  } catch {
    current = fromSystem();
  }
  return current;
}

export function setLocale(l: Locale): boolean {
  if (getLocale() === l) return false;
  current = l;
  try {
    writeFileSync(settingsPath(), JSON.stringify({ locale: l }, null, 2));
  } catch (err) {
    console.error("[desktop] failed to save app settings:", (err as Error).message);
  }
  return true;
}

export function tm(key: MsgKey, params?: Params): string {
  const s: string = getLocale() === "en" ? EN[key] : key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}
