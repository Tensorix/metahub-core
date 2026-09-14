import { defaultKeymap } from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";

export const APP_RESERVED_KEYS = ["Mod-[", "Mod-]", "Alt-ArrowLeft", "Alt-ArrowRight"];

export const proseDefaultKeymap: readonly KeyBinding[] = defaultKeymap.filter(
  (b) => !APP_RESERVED_KEYS.includes(b.key ?? ""),
);
