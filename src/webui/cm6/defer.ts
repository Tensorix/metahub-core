// The coordinate-read chokepoint for editor chrome.
//
// Reading the editor layout (`coordsAtPos` / `posAtCoords` / `scrollDOM` rects)
// during CM6's update phase throws "Reading the editor layout isn't allowed
// during an update" (and a `view.requestMeasure` whose read re-enters layout can
// throw the same way). The reliable way to read coords after a transaction
// settles is `requestAnimationFrame`, which is what this wraps. Used by the
// slash menu, format bar, hover gutter, and TOC scroll-spy for their post-update
// coordinate reads.

/** Run `cb` on the next animation frame (after the current update settles).
 *  Returns the frame handle so callers can cancel on teardown. */
export function deferCoords(cb: () => void): number {
  return requestAnimationFrame(cb);
}

/** Cancel a frame scheduled by {@link deferCoords}. */
export function cancelDeferred(handle: number): void {
  if (handle) cancelAnimationFrame(handle);
}
