/** Keep readable names where they resolve uniquely; use IDs for collisions. */
export function csvPropertyHeaders(
  props: readonly { id: string; name: string }[],
): string[] {
  const ids = new Set(props.map((p) => p.id));
  const counts = new Map<string, number>();
  for (const p of props)
    counts.set(
      p.name.toLowerCase(),
      (counts.get(p.name.toLowerCase()) ?? 0) + 1,
    );
  return props.map((p) =>
    p.name.toLowerCase() === "id" ||
    counts.get(p.name.toLowerCase()) !== 1 ||
    ids.has(p.name)
      ? p.id
      : p.name,
  );
}
