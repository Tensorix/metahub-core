/** A deliberate leftward drag; a fast short flick only reveals the action. */
export function isFullSwipe(
  translationX: number,
  translationY: number,
  width: number,
) {
  return (
    width > 0 &&
    -translationX >= Math.max(160, width * 0.65) &&
    Math.abs(translationY) < Math.abs(translationX) * 0.5
  );
}
