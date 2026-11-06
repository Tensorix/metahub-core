import {
  useState,
  useRef,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as Haptics from "expo-haptics";
export type DragPosition = { x: number; y: number; dx: number; dy: number };
/** Scroll wins until the hold activates; cancellation never commits. */
export function DragItem({
  children,
  onDrop,
  onMove,
  onFinish,
  onBegin,
  delay = 350,
  floating = false,
}: {
  children: ReactNode;
  delay?: number;
  floating?: boolean;
  onDrop(p: DragPosition): void;
  onMove?(p: DragPosition): void;
  onFinish?(): void;
  onBegin?(): void;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 }),
    [dragging, setDragging] = useState(false);
  const callbacks = useRef({ onBegin, onMove, onDrop, onFinish });
  useLayoutEffect(() => {
    callbacks.current = { onBegin, onMove, onDrop, onFinish };
  }, [onBegin, onMove, onDrop, onFinish]);
  // Gesture builder methods register handlers; they never execute them during render.
  // Keep the recognizer stable while reading the latest callbacks only on native events.
  /* eslint-disable react-hooks/refs */
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(delay)
        .runOnJS(true)
        .onStart(() => {
          setDragging(true);
          callbacks.current.onBegin?.();
          void Haptics.selectionAsync();
        })
        .onUpdate((e) => {
          setOffset({ x: e.translationX, y: e.translationY });
          callbacks.current.onMove?.({
            x: e.absoluteX,
            y: e.absoluteY,
            dx: e.translationX,
            dy: e.translationY,
          });
        })
        .onEnd((e, success) => {
          if (success)
            callbacks.current.onDrop({
              x: e.absoluteX,
              y: e.absoluteY,
              dx: e.translationX,
              dy: e.translationY,
            });
        })
        .onFinalize(() => {
          setDragging(false);
          setOffset({ x: 0, y: 0 });
          callbacks.current.onFinish?.();
        }),
    [delay],
  );
  /* eslint-enable react-hooks/refs */
  return (
    <GestureDetector gesture={gesture}>
      <View
        style={{
          zIndex: dragging ? 100 : 0,
          opacity: dragging ? (floating ? 0.3 : 0.8) : 1,
          transform: floating
            ? []
            : [{ translateX: offset.x }, { translateY: offset.y }],
        }}
      >
        {children}
      </View>
    </GestureDetector>
  );
}
