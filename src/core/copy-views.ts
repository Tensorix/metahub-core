/** Remap only the known saved-view reference slots, leaving extension metadata intact. */
export function copyViews(
  raw: unknown,
  props: Map<string, string>,
  records: Map<string, string>,
  selfRelations: Set<string>,
): unknown {
  if (!Array.isArray(raw)) return raw;
  const object = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x);
  const prop = (x: unknown) =>
    typeof x === "string" ? (props.get(x) ?? x) : x;
  return raw.map((v) => {
    if (!object(v)) return v;
    const out = { ...v };
    for (const key of ["group", "dateProp", "start", "end"])
      if (key in out) out[key] = prop(out[key]);
    if (Array.isArray(v.hidden)) out.hidden = v.hidden.map(prop);
    if (Array.isArray(v.sort))
      out.sort = v.sort.map((s: unknown) =>
        object(s) ? { ...s, prop: prop(s.prop) } : s,
      );
    if (object(v.filter) && Array.isArray(v.filter.rules))
      out.filter = {
        ...v.filter,
        rules: v.filter.rules.map((r: unknown) => {
          if (!object(r)) return r;
          return {
            ...r,
            prop: prop(r.prop),
            ...(typeof r.prop === "string" && selfRelations.has(r.prop) && Array.isArray(r.value)
              ? { value: r.value.map((id: unknown) => typeof id === "string" ? records.get(id) ?? id : id) }
              : {}),
          };
        }),
      };
    if (object(v.calc))
      out.calc = Object.fromEntries(
        Object.entries(v.calc).map(([id, value]) => [
          props.get(id) ?? id,
          value,
        ]),
      );
    return out;
  });
}
