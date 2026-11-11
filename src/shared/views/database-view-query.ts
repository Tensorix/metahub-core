import type { PropertyRow } from "../../core/properties";
import type { ViewDef } from "./model";
import type { RecordQuery } from "./query";
/** Shared by the native opening coordinator and all Web hosts. */
export function databaseViewQuery(
  view: ViewDef,
  props: PropertyRow[],
  search = "",
): RecordQuery {
  const dates = props.filter((p) => p.type === "date");
  const group =
    view.group ??
    (
      props.find((p) => p.type === "select") ??
      props.find((p) => p.type === "multi_select")
    )?.id;
  const date =
    (view.layout === "calendar" ? view.dateProp : view.start) ?? dates[0]?.id;
  const end =
    view.end === null
      ? undefined
      : (view.end ?? dates.find((p) => p.id !== date)?.id);
  return {
    filter: view.filter,
    sort: view.sort,
    search,
    calc: view.calc,
    partitions:
      view.layout === "table"
        ? {}
        : view.layout === "board"
          ? { group }
          : { date, end },
  };
}
export function databaseQueryKey(query: RecordQuery) {
  const { owner: _owner, protocol: _protocol, ...content } = query;
  return JSON.stringify(content, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
}
