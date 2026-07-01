// The single coordinate-read chokepoint for all editor chrome.
//
// Reading the editor layout (`coordsAtPos` / `posAtCoords` / `scrollDOM` rects)
// during CM6's update or measure phase throws "Reading the editor layout isn't
// allowed during an update", and `view.requestMeasure` ALSO throws (readMeasured)
// when the read is what schedules it. The only reliable way to read coords after
// a transaction settles is `requestAnimationFrame`. Every chrome module (slash
// menu, format bar, TOC scroll-spy, gutter, find) routes its coord reads through
// here so the rule is enforced in exactly one place.

/** Run `cb` on the next animation frame (after the current update settles).
 *  Returns the frame handle so callers can cancel on teardown. */
export function deferCoords(cb: () => void): number {
  return requestAnimationFrame(cb);
}

/** Cancel a frame scheduled by {@link deferCoords}. */
export function cancelDeferred(handle: number): void {
  if (handle) cancelAnimationFrame(handle);
}
