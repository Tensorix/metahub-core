/** Emit only after the view's requested page has committed. Each session's
 * trace de-duplicates the marker; native and Web keep their own clocks. */
export function databaseFirstFrame(current: () => boolean) {
  if (!document.body.classList.contains("mobile-database")) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (current()) document.dispatchEvent(new Event("database-first-frame"));
    }),
  );
}
