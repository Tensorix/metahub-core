/** @jsxImportSource preact */
import { comboKeys, comboOf, isSymKey, type Combo } from "./shortcuts.ts";

export function Kbd({ id, combo }: { id?: string; combo?: Combo }) {
  const c = combo ?? (id ? comboOf(id) : null);
  if (!c) return null;
  return (
    <kbd class="kbd">
      {comboKeys(c).map((k, i) => (
        <span key={i} class={"key" + (isSymKey(k) ? " sym" : "")}>{k}</span>
      ))}
    </kbd>
  );
}
