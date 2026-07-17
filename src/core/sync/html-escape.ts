// The one HTML text-escaper, shared by share-render (the markdown engine) and
// room-serve (its two static pages). Kept in its own tiny module so room-serve —
// which bundles into the Durable Object — can reuse it without importing
// share-render and dragging the whole markdown renderer into the DO bundle.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
