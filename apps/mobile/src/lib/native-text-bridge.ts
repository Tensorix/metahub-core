/** Expo's native ObservableState already contains user edits before JS receives
 * onChangeText. Parent props may echo those edits later; writing an echo back
 * schedules an older value on the UI thread and can erase newer keystrokes. */
export function createNativeTextBridge(
  initial: string,
  initialResetKey?: string | number,
) {
  let parentText = initial;
  let resetKey = initialResetKey;
  const pendingEchoes: string[] = [];
  return {
    nativeChanged(value: string) {
      pendingEchoes.push(value);
    },
    /** Return true only for an external replacement. A changed resetKey makes
     * reset intent explicit even if its text equals a pending native echo. */
    reconcile(text: string, nextResetKey?: string | number): boolean {
      const reset = !Object.is(resetKey, nextResetKey);
      resetKey = nextResetKey;
      const unchanged = parentText === text;
      parentText = text;
      if (!reset) {
        const echoed = pendingEchoes.indexOf(text);
        if (echoed >= 0) {
          // Retire only through the earliest matching edit: a -> ab -> a
          // must not let the first a acknowledgment eat the future ab/a.
          // A later known echo can retire skipped, batched history safely.
          pendingEchoes.splice(0, echoed + 1);
          return false;
        }
      }
      if (!reset && unchanged) return false;
      pendingEchoes.length = 0;
      return true;
    },
  };
}
