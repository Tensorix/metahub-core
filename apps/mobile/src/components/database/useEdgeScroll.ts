import type { ComponentRef } from "react";
import { useEffect, useRef } from "react";
import {
  ScrollView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
/** Keep scrolling while a held drag rests at an edge; release/cancel always stops it. */
export function useEdgeScroll(horizontal: boolean) {
  const ref =
    useRef<
      Pick<ComponentRef<typeof ScrollView>, "measureInWindow" | "scrollTo">
    >(null);
  const state = useRef({
    offset: 0,
    extent: 0,
    start: 0,
    size: 0,
    point: 0,
    origin: 0,
  });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );
  const measure = (_?: LayoutChangeEvent) =>
    ref.current?.measureInWindow((x, y, w, h) => {
      state.current.start = horizontal ? x : y;
      state.current.size = horizontal ? w : h;
    });
  const move = (point: number) => {
    state.current.point = point;
    if (timer.current) return;
    state.current.origin = state.current.offset;
    measure();
    timer.current = setInterval(() => {
      const s = state.current,
        local = s.point - s.start;
      const speed =
        local < 44
          ? -Math.min(12, (44 - local) / 4)
          : local > s.size - 44
            ? Math.min(12, (local - s.size + 44) / 4)
            : 0;
      if (!speed || !s.size) return;
      const next = Math.max(0, Math.min(s.extent - s.size, s.offset + speed));
      s.offset = next;
      ref.current?.scrollTo(
        horizontal
          ? { x: next, animated: false }
          : { y: next, animated: false },
      );
    }, 16);
  };
  return {
    attach: (
      node: Pick<
        ComponentRef<typeof ScrollView>,
        "measureInWindow" | "scrollTo"
      > | null,
    ) => {
      ref.current = node;
    },
    move,
    reset: (offset: number, extent: number) => {
      state.current.offset = offset;
      state.current.extent = extent;
    },
    stop,
    measure,
    scrollDelta: () => state.current.offset - state.current.origin,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      state.current.offset = horizontal
        ? e.nativeEvent.contentOffset.x
        : e.nativeEvent.contentOffset.y;
    },
    onContentSizeChange: (w: number, h: number) => {
      state.current.extent = horizontal ? w : h;
    },
  };
}
