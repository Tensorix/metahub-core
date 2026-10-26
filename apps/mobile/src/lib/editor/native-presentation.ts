type SaveResult = { ok: boolean; error?: string };

/** Native-only callback around the actual system UI API. Never sent through
 * the WebView protocol or wrapped around download/hash/persistence work. */
export type NativePresentation = <T>(open: () => Promise<T>) => Promise<T>;

/** Save while the WebView is active, before a system picker/share sheet can
 * suspend it. The resulting AppState change must not request another flush
 * from that suspended renderer. Ordinary backgrounding still flushes. */
export function createNativePresentationGuard(
  flush: () => Promise<SaveResult>,
  isCurrent: () => boolean,
  isActive: () => boolean = () => true,
) {
  let disposed = false;
  let busy = false;
  let presenting = false;
  return {
    isPresenting: () => presenting,
    dispose() {
      disposed = true;
    },
    async run<T>(open: () => Promise<T>): Promise<T> {
      if (disposed || !isCurrent()) throw new Error("编辑器会话已结束");
      if (busy) throw new Error("附件操作正在进行，请稍后重试");
      if (!isActive()) throw new Error("请返回文档后重试附件操作，草稿将保留");
      busy = true;
      try {
        const saved = await flush();
        if (disposed || !isCurrent()) throw new Error("编辑器会话已结束");
        if (!saved.ok) throw new Error(saved.error || "保存失败，草稿将保留");
        if (!isActive())
          throw new Error("请返回文档后重试附件操作，草稿将保留");
        presenting = true;
        return await open();
      } finally {
        presenting = false;
        busy = false;
      }
    },
  };
}
