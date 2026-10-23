/** Schedule one query; effect cleanup cancels it before the next query. */
export function scheduleSearch(commit: () => void, delay = 250): () => void {
  const timer = setTimeout(commit, delay);
  return () => clearTimeout(timer);
}
