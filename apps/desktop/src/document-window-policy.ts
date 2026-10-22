export function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && /^doc_[a-z0-9][a-z0-9-]*$/.test(value);
}

export interface WindowBounds { x: number; y: number; width: number; height: number }
/** Saved positions must survive unplugged monitors and corrupt settings. */
export function visibleDocumentBounds(saved: Partial<WindowBounds> | undefined, areas: WindowBounds[]): WindowBounds {
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1280, height: 832 };
  const valid = saved && [saved.x, saved.y, saved.width, saved.height].every((n) => typeof n === "number" && Number.isFinite(n));
  const area = valid ? areas.find((a) => saved.x! >= a.x && saved.x! < a.x + a.width && saved.y! >= a.y && saved.y! < a.y + a.height) ?? fallback : fallback;
  const width = Math.min(area.width, Math.max(520, valid ? saved.width! : 960));
  const height = Math.min(area.height, Math.max(400, valid ? saved.height! : 760));
  return {
    width, height,
    x: Math.min(area.x + area.width - width, Math.max(area.x, valid ? saved.x! : area.x + (area.width - width) / 2)),
    y: Math.min(area.y + area.height - height, Math.max(area.y, valid ? saved.y! : area.y + (area.height - height) / 2)),
  };
}
