export interface DocumentFlushResult {
  ok: boolean;
  error?: string;
}
/** Inert only stops new input; the bridge remains alive until its checkpoint,
 * save and acknowledgement have drained. No callback gate is closed here. */
export async function withFlushedDocument(
  editor: {
    setFrozen(value: boolean): void;
    flush(): Promise<DocumentFlushResult>;
  },
  isCurrent: () => boolean,
  action: () => void | Promise<void>,
) {
  editor.setFrozen(true);
  try {
    const result = await editor.flush();
    if (!isCurrent()) throw new Error("工作区会话已结束");
    if (!result.ok)
      throw new Error(result.error || "编辑器尚未就绪，请稍后重试");
    await action();
  } finally {
    if (isCurrent()) editor.setFrozen(false);
  }
}
/** Call only after the editor flush has settled. Callback admission is closed
 * before the delete starts; a failed commit restores it and retains recovery. */
export async function deleteFlushedDocument(actions: {
  pause(): void;
  commit(): Promise<{ ok: boolean }>;
  discardDraft(): void;
  resume(): void;
  deleted(): void;
}) {
  actions.pause();
  try {
    const result = await actions.commit();
    if (!result.ok) throw new Error("文档未能删除，请刷新后重试");
  } catch (error) {
    actions.resume();
    throw error;
  }
  actions.deleted();
  actions.discardDraft();
}

/** Keep successful write identity/version for retry, but only the captured form
 * revision may authorize leaving. Native input can arrive after blur/save. */
export async function saveDocumentForm<T>(actions: {
  revision(): number;
  write(): Promise<T>;
  remember(receipt: T): void;
  isCurrent(): boolean;
}) {
  if (!actions.isCurrent()) throw new Error("工作区会话已结束");
  const revision = actions.revision();
  const receipt = await actions.write();
  if (!actions.isCurrent()) throw new Error("工作区会话已结束");
  actions.remember(receipt);
  if (revision !== actions.revision())
    throw new Error("较早的修改已保存，新的修改仍待保存，请再次保存");
  return receipt;
}
