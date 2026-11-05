interface Editor {
  setFrozen(value: boolean): void;
  flush(): Promise<{ ok: boolean; error?: string }>;
}
const editors = new WeakMap<object, Set<() => Editor | null>>();
export function registerRecoveryEditor(session: object, editor: () => Editor | null): () => void {
  let active = editors.get(session);
  if (!active) { active = new Set(); editors.set(session,active); }
  active.add(editor);
  return () => { active.delete(editor); };
}
/** Freeze input before draining the bridge. Any missing/failed renderer aborts
 * protection; no navigation assumption can authorize a database swap. */
export async function freezeAndFlushEditors(session: object): Promise<() => void> {
  const frozen: Editor[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const editor of frozen) {
      try { editor.setFrozen(false); } catch { /* A detached renderer must not prevent session recovery. */ }
    }
  };
  try {
    for (const get of editors.get(session) ?? []) {
      const editor = get();
      if (!editor) throw new Error("编辑器尚未就绪，无法安全保全编辑");
      frozen.push(editor); editor.setFrozen(true);
    }
    for (const editor of frozen) {
      const result = await editor.flush();
      if (!result.ok) throw new Error(result.error || "编辑尚未保存，已停止更新本地副本");
    }
    return release;
  } catch (error) { release(); throw error; }
}
