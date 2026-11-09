import { useEffect, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "expo-router";
import { useSession } from "@/lib/auth/session";
import { undoStoreFor } from "@/lib/browse/undo-store";
import { NativeUndoNotice } from "./native/NativeUndoNotice";
import { NoticeOverlay } from "./native/NoticeOverlay";

/** Subscribe per browse screen and present above its native list. */
export function UndoNotice() {
  const session = useSession();
  const store = undoStoreFor(session.replica);
  const state = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const entry = state.entries[0];
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [laidOutEntry, setLaidOutEntry] = useState<number | null>(null);
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((value) => {
      if (active) setScreenReader(value);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      setScreenReader,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (
      !entry ||
      laidOutEntry !== entry.id ||
      !focused ||
      state.busy ||
      state.error
    )
      return;
    const timer = setTimeout(
      () => store.dismiss(entry.id),
      entry.undo ? (screenReader ? 20000 : 8000) : 2200,
    );
    return () => clearTimeout(timer);
  }, [
    entry,
    laidOutEntry,
    focused,
    state.busy,
    state.error,
    screenReader,
    store,
  ]);
  useEffect(() => {
    if (entry && focused)
      AccessibilityInfo.announceForAccessibility(state.error || entry.message);
  }, [entry, focused, state.error]);
  if (!entry || !focused) return null;
  return (
    <NoticeOverlay>
      <View
        key={entry.id}
        testID="undo-notice"
        pointerEvents="box-none"
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: Platform.OS === "ios" ? insets.bottom + 20 : 16,
          alignItems: "center",
        }}
      >
        <NativeUndoNotice
          message={state.error ? `撤销失败：${state.error}` : entry.message}
          queuedCount={state.entries.length - 1}
          canUndo={!!entry.undo}
          busy={state.busy}
          failed={!!state.error}
          onUndo={() => void store.undo(entry.id)}
          onReady={() => setLaidOutEntry(entry.id)}
        />
      </View>
    </NoticeOverlay>
  );
}
