import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface DatabasePresentation {
  touch: boolean;
  fontScale: number;
  row: number;
  wrappedRow: number;
  card: number;
  cardGap: number;
  timelineRow: number;
  timelineSide: number;
}

export function databasePresentation(touch = false, fontScale = 1, width = 1024): DatabasePresentation {
  const scale = Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
  return { touch, fontScale: scale, row: touch ? Math.ceil(48 * scale) : 44,
    wrappedRow: touch ? Math.ceil(84 * scale) : 80,
    card: touch ? Math.ceil(128 * scale) : 160, cardGap: touch ? 8 : 7,
    timelineRow: touch ? Math.ceil(56 * scale) : 36,
    timelineSide: touch ? Math.min(144, Math.max(112, width * .34)) : 200 };
}

/** One geometry source for layout and virtual windows; updates without remounting editors. */
export function useDatabasePresentation(width?: number) {
  const read = () => databasePresentation(
    document.body.classList.contains('mobile-database') || window.matchMedia?.('(pointer: coarse)').matches || false,
    Number(document.documentElement.dataset.fontScale ?? 1), width ?? window.innerWidth);
  const [value, setValue] = useState(read);
  useLayoutEffect(() => {
    const update = () => setValue(read());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('database-presentation', update);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('database-presentation', update); };
  }, [width]);
  return value;
}

export function useViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize(old => old.width === element.clientWidth && old.height === element.clientHeight ? old : { width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  });
  return [ref, size] as const;
}
