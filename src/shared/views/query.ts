import type { DbDriver } from "../../core/driver.ts";
import { listProperties } from "../../core/properties.ts";
import type { RecordRow } from "../../core/records.ts";
import {
  applyFilter,
  compareCells,
  searchRecords,
  computeCalc,
  type CalcKind,
  type FilterSet,
  type SortRule,
} from "./model.ts";

import { parseDate } from "./date.ts";

export interface RecordQuery {
  protocol?: 2;
  owner?: string;
  partitions?: { group?: string; date?: string; end?: string };
  /** Additional layout constraints are ANDed with the whole saved filter. */
  group?: { prop: string; value: string | null };
  dates?: {
    start: string;
    end?: string;
    from?: string;
    to?: string;
    unscheduled?: boolean;
  };
  calc?: Record<string, CalcKind>;
  search?: string;
  filter?: FilterSet;
  sort?: SortRule[];
  offset?: number;
  limit?: number;
}
/** Scan in bounded chunks, retaining only the requested sorted prefix. Filters
 * and search apply to the entire database before pagination, including ties. */
function* scanRecords(
  db: DbDriver,
  databaseId: string,
  query: RecordQuery = {},
  indexOnly = false,
  onRow?: (row: RecordRow) => void,
) {
  // The async facade must get a cancellable turn before any SQLite access.
  // Index creation belongs to schema migration, never a read request.
  yield;
  const props = listProperties(db, databaseId);
  const limit = Number.isFinite(query.limit)
    ? Math.max(1, Math.min(200, Math.floor(query.limit!)))
    : 60;
  const offset = Number.isFinite(query.offset)
    ? Math.max(0, Math.floor(query.offset!))
    : 0;
  const keep = offset + limit;
  const calculations = Object.entries(query.calc ?? {}).flatMap(
    ([id, kind]) => {
      const prop = props.find((p) => p.id === id);
      return prop ? [{ prop, kind, values: [] as unknown[] }] : [];
    },
  );
  const statistics = () =>
    Object.fromEntries(
      calculations.map((c) => [
        c.prop.id,
        computeCalc(c.kind, c.prop, c.values),
      ]),
    );
  const matchesLayout = (rec: RecordRow) => {
    if (query.group) {
      const prop = props.find(
        (p) => p.id === query.group!.prop && p.type === "select",
      );
      if (!prop) return false;
      const value = rec.cells[prop.id];
      const normalized =
        typeof value === "string" && prop.config?.options?.includes(value)
          ? value
          : null;
      if (normalized !== query.group.value) return false;
    }
    if (query.dates) {
      const dates = query.dates;
      if (!props.some((p) => p.id === dates.start && p.type === "date"))
        return false;
      const start = parseDate(rec.cells[dates.start]);
      if (dates.unscheduled) return !start;
      if (!start) return false;
      const rawEnd = dates.end ? parseDate(rec.cells[dates.end]) : null;
      const end = rawEnd && rawEnd > start ? rawEnd : start;
      const from = parseDate(dates.from),
        to = parseDate(dates.to);
      if ((from && end < from) || (to && start > to)) return false;
    }
    return true;
  };
  const sort = (query.sort ?? []).flatMap((rule) => {
    const prop = props.find((p) => p.id === rule.prop);
    return prop ? [{ rule, prop }] : [];
  });
  const compare = (a: RecordRow, b: RecordRow) => {
    for (const { rule, prop } of sort) {
      const result = compareCells(prop, a.cells[prop.id], b.cells[prop.id]);
      if (result && Number.isFinite(result))
        return rule.desc ? -result : result;
      // +/-Infinity are valid comparisons for an empty numeric cell.
      if (result === Infinity || result === -Infinity)
        return rule.desc ? -result : result;
    }
    return 0;
  };
  // Manual-order sessions project only partition keys. SQLite walks the existing
  // order index; large text/attachment cells never enter the JS query index.
  if (
    indexOnly &&
    !sort.length &&
    !query.search?.trim() &&
    !query.filter?.rules.length &&
    !query.group &&
    !query.dates &&
    !calculations.length
  ) {
    const keys = [...new Set(Object.values(query.partitions ?? {}).filter((id):id is string=>typeof id==="string"))];
    const projection = keys.length
      ? `json_object(${keys.map(() => "?,json_extract(data,?)").join(",")})`
      : "'{}'";
    const fields = keys.flatMap((id) => [id, `$.${JSON.stringify(id)}`]);
    const records: RecordRow[] = [];
    let cursor: { order_key: string | null; id: string } | null = null;
    for (;;) {
      const after = !cursor
        ? ""
        : cursor.order_key === null
          ? " AND order_key IS NULL AND id > ?"
          : " AND (order_key IS NULL OR order_key > ? OR (order_key = ? AND id > ?))";
      const args = !cursor
        ? []
        : cursor.order_key === null
          ? [cursor.id]
          : [cursor.order_key, cursor.order_key, cursor.id];
      const chunk = db
        .query(
          `SELECT id,order_key,${projection} AS data FROM records WHERE database_id=? AND __deleted=0${after} ORDER BY order_key IS NULL,order_key,id LIMIT 200`,
        )
        .all(...fields, databaseId, ...args) as {
        id: string;
        order_key: string | null;
        data: string;
      }[];
      for (const row of chunk) {
        const rec = {
          id: row.id,
          database_id: databaseId,
          cells: JSON.parse(row.data),
          values: {},
        };
        records.push(rec);
        onRow?.(rec);
      }
      if (chunk.length < 200) break;
      cursor = chunk[chunk.length - 1]!;
      yield;
    }
    return {
      records,
      total: records.length,
      calc: {},
      hasMore: false,
      offset: 0,
      limit: records.length,
    };
  }
  // Manual-order lists can page directly through the index. Scanning and
  // parsing every record on every scroll page is unnecessary without predicates.
  if (
    !indexOnly &&
    !sort.length &&
    !query.search?.trim() &&
    !query.filter?.rules.length &&
    !query.group &&
    !query.dates &&
    !calculations.length
  ) {
    const total = (
      db
        .query(
          "SELECT count(*) AS n FROM records WHERE database_id = ? AND __deleted = 0",
        )
        .get(databaseId) as { n: number }
    ).n;
    const rows = db
      .query(
        "SELECT id, database_id, data FROM records WHERE database_id = ? AND __deleted = 0 ORDER BY order_key IS NULL, order_key, id LIMIT ? OFFSET ?",
      )
      .all(databaseId, limit, offset) as {
      id: string;
      database_id: string;
      data: string;
    }[];
    const records = rows.map((row) => {
      const raw = JSON.parse(row.data || "{}") as Record<string, unknown>;
      const cells: Record<string, unknown> = {},
        values: Record<string, unknown> = {};
      for (const prop of props)
        if (Object.hasOwn(raw, prop.id)) {
          cells[prop.id] = raw[prop.id];
          values[prop.name] = raw[prop.id];
        }
      return { id: row.id, database_id: row.database_id, cells, values };
    });
    return {
      records,
      calc: statistics(),
      total,
      hasMore: total > offset + limit,
      offset,
      limit,
    };
  }
  // A field sort/filter does not need unrelated long text or attachment bodies.
  // Search still inspects every property using the existing typed model.
  const required = new Set([
    ...sort.map(({ prop }) => prop.id),
    ...(query.filter?.rules.map((rule) => rule.prop) ?? []),
    ...calculations.map((c) => c.prop.id),
    ...Object.values(query.partitions ?? {}),
    query.group?.prop,
    query.dates?.start,
    query.dates?.end,
  ]);
  const readProps =
    indexOnly && !query.search?.trim()
      ? props.filter((p) => required.has(p.id))
      : props;
  const projected = readProps.length < props.length;
  const projection = projected
    ? readProps.length
      ? `json_object(${readProps.map(() => "?,json_extract(data,?)").join(",")})`
      : "'{}'"
    : "data";
  const projectionArgs = projected
    ? readProps.flatMap((p) => [p.id, `$.${JSON.stringify(p.id)}`])
    : [];
  const retained: RecordRow[] = [];
  let total = 0;
  let cursor: { order_key: string | null; id: string } | null = null;
  for (;;) {
    const after = !cursor
      ? ""
      : cursor.order_key === null
        ? " AND order_key IS NULL AND id > ?"
        : " AND (order_key IS NULL OR order_key > ? OR (order_key = ? AND id > ?))";
    const args = !cursor
      ? []
      : cursor.order_key === null
        ? [cursor.id]
        : [cursor.order_key, cursor.order_key, cursor.id];
    const chunk = db
      .query(
        `SELECT id, database_id, ${projection} AS data, order_key FROM records WHERE database_id = ? AND __deleted = 0${after} ORDER BY order_key IS NULL, order_key, id LIMIT 200`,
      )
      .all(...projectionArgs, databaseId, ...args) as {
      id: string;
      order_key: string | null;
      database_id: string;
      data: string;
    }[];
    for (const row of chunk) {
      const raw = JSON.parse(row.data || "{}") as Record<string, unknown>;
      const cells: Record<string, unknown> = {},
        values: Record<string, unknown> = {};
      for (const prop of readProps)
        if (Object.hasOwn(raw, prop.id)) {
          cells[prop.id] = raw[prop.id];
          values[prop.name] = raw[prop.id];
        }
      const rec: RecordRow = {
        id: row.id,
        database_id: row.database_id,
        cells,
        values,
      };
      if (query.filter && !applyFilter([rec], props, query.filter).length)
        continue;
      if (!searchRecords([rec], props, query.search ?? "").length) continue;
      if (!matchesLayout(rec)) continue;
      for (const c of calculations) c.values.push(rec.cells[c.prop.id]);
      total++;
      if (indexOnly) {
        retained.push({
          ...rec,
          values: {},
          cells: Object.fromEntries(
            [
              ...new Set([
                ...sort.map(({ prop }) => prop.id),
                ...Object.values(query.partitions ?? {}),
              ]),
            ].map((id) => [id, rec.cells[id]]),
          ),
        });
        onRow?.(retained[retained.length - 1]!);
        continue;
      }
      if (!sort.length) {
        if (retained.length < keep) retained.push(rec);
        continue;
      }
      let low = 0,
        high = retained.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (compare(rec, retained[mid]!) < 0) high = mid;
        else low = mid + 1;
      }
      if (low < keep) {
        retained.splice(low, 0, rec);
        if (retained.length > keep) retained.pop();
      }
    }
    if (chunk.length < 200) break;
    cursor = chunk[chunk.length - 1]!;
    yield;
  }
  if (indexOnly) {
    // Bottom-up merge sort yields between bounded runs, keeping cancellation
    // responsive even when a large result has many equal sort keys.
    let source = retained.slice(),
      target = new Array<RecordRow>(source.length);
    for (let width = 1; sort.length && width < source.length; width *= 2) {
      for (let base = 0; base < source.length; base += width * 2) {
        let left = base,
          right = Math.min(base + width, source.length);
        const middle = right,
          end = Math.min(base + width * 2, source.length);
        for (let out = base; out < end; out++) {
          target[out] =
            left < middle &&
            (right >= end || compare(source[left]!, source[right]!) <= 0)
              ? source[left++]!
              : source[right++]!;
          if ((out + 1) % 4096 === 0) yield;
        }
      }
      [source, target] = [target, source];
    }
    return {
      records: source,
      calc: statistics(),
      total,
      hasMore: false,
      offset: 0,
      limit: total,
    };
  }
  return {
    records: retained.slice(offset),
    calc: statistics(),
    total,
    hasMore: total > offset + limit,
    offset,
    limit,
  };
}

export function queryRecords(
  db: DbDriver,
  databaseId: string,
  query: RecordQuery = {},
) {
  const scan = scanRecords(db, databaseId, query);
  let step = scan.next();
  while (!step.done) step = scan.next();
  return step.value;
}
/** Yield between SQLite chunks so native gestures and cancellation can run. */
export async function queryRecordsAsync(
  db: DbDriver,
  databaseId: string,
  query: RecordQuery = {},
  isCurrent = () => true,
) {
  const scan = scanRecords(db, databaseId, query);
  for (;;) {
    if (!isCurrent()) throw new Error("Replica query cancelled");
    const step = scan.next();
    if (step.done) return step.value;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Disposable query indexes contain IDs only; record bodies are read per page.
 * The owner supplies a revision that changes for local writes and sync merges. */
export function createRecordQuerySessions(
  db: DbDriver,
  revision: (databaseId?: string) => number,
) {
  type Stream = {
    databaseId: string;
    revision: number;
    ids: string[];
    partitions: Map<string, string[]>;
    calc: Record<string, string>;
    touched: number;
    done: boolean;
    error?: Error;
    range: { min: string | null; max: string | null };
    owner?: string;
  };
  const streams = new Map<string, Stream>();
  const describe = (id: string, state: Stream) => ({
    id,
    revision: state.revision,
    total: state.ids.length + (state.done ? 0 : 1),
    calc: state.calc,
    partitions: Object.fromEntries(
      [...state.partitions].map(([key, ids]) => [key, ids.length]),
    ),
    range: state.range,
    protocol: 2 as const,
    mode: "index" as const,
    statistics: state.done ? ("complete" as const) : ("loading" as const),
    totalExact: state.done,
    progress: state.ids.length,
  });
  const direct = new Map<
    string,
    {
      databaseId: string;
      revision: number;
      total: number;
      touched: number;
      cursors: Map<number, { order_key: string | null; id: string }>;
    }
  >();
  const sessions = new Map<
    string,
    {
      databaseId: string;
      revision: number;
      ids: string[];
      partitions: Map<string, string[]>;
      calc: Record<string, string>;
      range: { min: string | null; max: string | null };
      touched: number;
    }
  >();
  let serial = 0,
    generation = 0,
    ownerSerial = 0;
  const owners = new Map<string, number>();
  const sweep = () => {
    for (const [id, state] of streams)
      if (
        Date.now() - state.touched > 300_000 ||
        state.revision !== revision(state.databaseId)
      )
        streams.delete(id);
    for (const [id, session] of direct)
      if (
        Date.now() - session.touched > 300_000 ||
        session.revision !== revision(session.databaseId)
      )
        direct.delete(id);
    for (const [id, session] of sessions)
      if (
        Date.now() - session.touched > 300_000 ||
        session.revision !== revision(session.databaseId)
      )
        sessions.delete(id);
  };
  return {
    async open(
      databaseId: string,
      query: RecordQuery = {},
      isCurrent = () => true,
    ) {
      const version = revision(databaseId),
        epoch = generation;
      const ownerEpoch = query.owner ? ++ownerSerial : 0;
      if (query.owner) owners.set(query.owner, ownerEpoch);
      if (
        query.protocol === 2 &&
        !query.sort?.length &&
        !query.search?.trim() &&
        !query.filter?.rules.length &&
        !query.group &&
        !query.dates &&
        !Object.keys(query.calc ?? {}).length &&
        !Object.values(query.partitions ?? {}).some(Boolean)
      ) {
        if (!isCurrent()) throw new Error("Replica query cancelled");
        sweep();
        while (direct.size >= 8) direct.delete(direct.keys().next().value!);
        const total = (
          db
            .query(
              "SELECT count(*) AS n FROM records WHERE database_id=? AND __deleted=0",
            )
            .get(databaseId) as { n: number }
        ).n;
        const id = `cursor_${++serial}`;
        direct.set(id, {
          databaseId,
          revision: version,
          total,
          touched: Date.now(),
          cursors: new Map(),
        });
        return {
          id,
          revision: version,
          total,
          calc: {},
          partitions: {},
          range: { min: null, max: null },
          protocol: 2 as const,
          mode: "cursor" as const,
          statistics: "complete" as const,
        };
      }
      if (query.protocol === 2 && !query.sort?.length) {
        sweep();
        while (streams.size >= 8) streams.delete(streams.keys().next().value!);
        const id = `stream_${++serial}`;
        const state: Stream = {
          databaseId,
          revision: version,
          ids: [],
          partitions: new Map(),
          calc: {},
          touched: Date.now(),
          done: false,
          range: { min: null, max: null },
          owner: query.owner,
        };
        streams.set(id, state);
        const fields = listProperties(db, databaseId),
          group = fields.find((p) => p.id === query.partitions?.group);
        const add = (key: string, rid: string) => {
          let ids = state.partitions.get(key);
          if (!ids) state.partitions.set(key, (ids = []));
          ids.push(rid);
        };
        const scan = scanRecords(db, databaseId, query, true, (row) => {
          state.ids.push(row.id);
          if (group) {
            const raw = row.cells[group.id],
              options = group.config?.options ?? [];
            const keys = [
              ...new Set(
                (Array.isArray(raw) ? raw : [raw]).filter(
                  (v) => typeof v === "string" && options.includes(v),
                ),
              ),
            ];
            for (const key of keys.length ? keys : [null])
              add("group:" + JSON.stringify(key), row.id);
          }
          if (query.partitions?.date) {
            const date = parseDate(row.cells[query.partitions.date]);
            const iso = date
              ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
              : "";
            add("date:" + iso, row.id);
            if (iso) {
              add("date:scheduled", row.id);
              const end = query.partitions.end
                ? parseDate(row.cells[query.partitions.end])
                : null;
              const last =
                end && end > date!
                  ? `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`
                  : iso;
              if (!state.range.min || iso < state.range.min)
                state.range.min = iso;
              if (!state.range.max || last > state.range.max)
                state.range.max = last;
            }
          }
        });
        let release!: () => void;
        const first = new Promise<void>((resolve) => {
          release = resolve;
        });
        void (async () => {
          try {
            for (;;) {
              if (
                !isCurrent() ||
                generation !== epoch ||
                !streams.has(id) ||
                (query.owner && owners.get(query.owner) !== ownerEpoch)
              )
                throw new Error("Replica query cancelled");
              if (revision(databaseId) !== version)
                throw new Error("Record query stale");
              const step = scan.next();
              if (step.done) {
                state.done = true;
                state.calc = step.value.calc;
                release();
                break;
              }
              if (state.ids.length >= 100) release();
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
          } catch (error) {
            state.error =
              error instanceof Error ? error : new Error(String(error));
            release();
          }
        })();
        await first;
        if (state.error) throw state.error;
        return describe(id, state);
      }
      const scan = scanRecords(db, databaseId, query, true);
      for (;;) {
        if (
          !isCurrent() ||
          generation !== epoch ||
          (query.owner && owners.get(query.owner) !== ownerEpoch)
        )
          throw new Error("Replica query cancelled");
        if (revision(databaseId) !== version)
          throw new Error("Record query stale");
        const step = scan.next();
        if (step.done) {
          sweep();
          while (sessions.size >= 8)
            sessions.delete(sessions.keys().next().value!);
          const id = `query_${++serial}`;
          const { records, calc, total } = step.value;
          const partitions = new Map<string, string[]>();
          const add = (key: string, rid: string) => {
            const ids = partitions.get(key) ?? [];
            ids.push(rid);
            partitions.set(key, ids);
          };
          const fields = listProperties(db, databaseId);
          const group = fields.find((p) => p.id === query.partitions?.group);
          let min: string | null = null,
            max: string | null = null;
          let partitionWork = 0;
          for (const row of records) {
            if (++partitionWork % 500 === 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              if (
                !isCurrent() ||
                generation !== epoch ||
                (query.owner && owners.get(query.owner) !== ownerEpoch)
              )
                throw new Error("Replica query cancelled");
              if (revision(databaseId) !== version)
                throw new Error("Record query stale");
            }
            if (group) {
              const raw = row.cells[group.id],
                options = group.config?.options ?? [];
              const keys = [
                ...new Set(
                  (Array.isArray(raw) ? raw : [raw]).filter(
                    (v) => typeof v === "string" && options.includes(v),
                  ),
                ),
              ];
              for (const key of keys.length ? keys : [null])
                add(`group:${JSON.stringify(key)}`, row.id);
            }
            if (query.partitions?.date) {
              const date = parseDate(row.cells[query.partitions.date]);
              const iso = date
                ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
                : "";
              add(`date:${iso}`, row.id);
              if (iso) {
                add("date:scheduled", row.id);
                const end = query.partitions.end
                  ? parseDate(row.cells[query.partitions.end])
                  : null;
                const last =
                  end && end > date!
                    ? `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`
                    : iso;
                if (!min || iso < min) min = iso;
                if (!max || last > max) max = last;
              }
            }
          }
          sessions.set(id, {
            databaseId,
            revision: version,
            ids: records.map((r) => r.id),
            partitions,
            calc,
            range: { min, max },
            touched: Date.now(),
          });
          return {
            id,
            revision: version,
            total,
            calc,
            partitions: Object.fromEntries(
              [...partitions].map(([key, ids]) => [key, ids.length]),
            ),
            range: { min, max },
          };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    },
    page(id: string, offset = 0, limit = 100, partition?: string) {
      sweep();
      const streaming = streams.get(id);
      if (streaming) {
        if (streaming.error) throw streaming.error;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new Error("Invalid record query window");
        streaming.touched = Date.now();
        const ids = (
          partition == null
            ? streaming.ids
            : (streaming.partitions.get(partition) ?? [])
        ).slice(offset, offset + limit);
        const props = listProperties(db, streaming.databaseId);
        const raw = ids.length
          ? (db
              .query(
                `SELECT id,data FROM records WHERE database_id=? AND __deleted=0 AND id IN (${ids.map(() => "?").join(",")})`,
              )
              .all(streaming.databaseId, ...ids) as {
              id: string;
              data: string;
            }[])
          : [];
        const rows = new Map(
          raw.map((row) => {
            const data = JSON.parse(row.data || "{}"),
              cells: Record<string, unknown> = {},
              values: Record<string, unknown> = {};
            for (const p of props)
              if (Object.hasOwn(data, p.id)) {
                cells[p.id] = data[p.id];
                values[p.name] = data[p.id];
              }
            return [
              row.id,
              { id: row.id, database_id: streaming.databaseId, cells, values },
            ];
          }),
        );
        if (rows.size !== ids.length) throw new Error("Record query stale");
        const total =
          partition == null
            ? streaming.ids.length
            : (streaming.partitions.get(partition)?.length ?? 0);
        return {
          records: ids.map((id) => rows.get(id)!),
          total: total + (streaming.done ? 0 : 1),
          offset,
          limit,
          hasMore: !streaming.done || offset + ids.length < total,
          calc: streaming.calc,
        };
      }
      const cursorSession = direct.get(id);
      if (cursorSession) {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new Error("Invalid record query window");
        cursorSession.touched = Date.now();
        if (partition != null) throw new Error("Query has no partitions");
        let cursor = cursorSession.cursors.get(offset);
        // A distant rank seek reads only one indexed key; sequential pages always use cursors.
        if (offset && !cursor)
          cursor = db
            .query(
              "SELECT order_key,id FROM records WHERE database_id=? AND __deleted=0 ORDER BY order_key IS NULL,order_key,id LIMIT 1 OFFSET ?",
            )
            .get(cursorSession.databaseId, offset - 1) as typeof cursor;
        const after = !cursor
          ? ""
          : cursor.order_key === null
            ? " AND order_key IS NULL AND id > ?"
            : " AND (order_key IS NULL OR order_key > ? OR (order_key = ? AND id > ?))";
        const args = !cursor
          ? []
          : cursor.order_key === null
            ? [cursor.id]
            : [cursor.order_key, cursor.order_key, cursor.id];
        const raw =
          offset >= cursorSession.total
            ? []
            : (db
                .query(
                  `SELECT id,data,order_key FROM records WHERE database_id=? AND __deleted=0${after} ORDER BY order_key IS NULL,order_key,id LIMIT ?`,
                )
                .all(cursorSession.databaseId, ...args, limit) as {
                id: string;
                data: string;
                order_key: string | null;
              }[]);
        if (raw.length)
          cursorSession.cursors.set(offset + raw.length, {
            id: raw.at(-1)!.id,
            order_key: raw.at(-1)!.order_key,
          });
        while (cursorSession.cursors.size > 128)
          cursorSession.cursors.delete(
            cursorSession.cursors.keys().next().value!,
          );
        const props = listProperties(db, cursorSession.databaseId);
        const records = raw.map((row) => {
          const data = JSON.parse(row.data || "{}"),
            cells: Record<string, unknown> = {},
            values: Record<string, unknown> = {};
          for (const prop of props)
            if (Object.hasOwn(data, prop.id)) {
              cells[prop.id] = data[prop.id];
              values[prop.name] = data[prop.id];
            }
          return {
            id: row.id,
            database_id: cursorSession.databaseId,
            cells,
            values,
          };
        });
        return {
          records,
          total: cursorSession.total,
          offset,
          limit,
          hasMore: offset + records.length < cursorSession.total,
          calc: {},
        };
      }
      const session = sessions.get(id);
      if (!session) throw new Error("Record query stale");
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new Error("Invalid record query window");
      session.touched = Date.now();
      const resultIds =
        partition == null
          ? session.ids
          : (session.partitions.get(partition) ?? []);
      const ids = resultIds.slice(offset, offset + limit);
      const props = listProperties(db, session.databaseId);
      const rows = ids.length
        ? (db
            .query(
              `SELECT id, data FROM records WHERE database_id = ? AND __deleted = 0 AND id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(session.databaseId, ...ids) as { id: string; data: string }[])
        : [];
      const byId = new Map(
        rows.map((row) => {
          const raw = JSON.parse(row.data || "{}"),
            cells: Record<string, unknown> = {},
            values: Record<string, unknown> = {};
          for (const prop of props)
            if (Object.hasOwn(raw, prop.id)) {
              cells[prop.id] = raw[prop.id];
              values[prop.name] = raw[prop.id];
            }
          return [
            row.id,
            { id: row.id, database_id: session.databaseId, cells, values },
          ] as const;
        }),
      );
      if (byId.size !== ids.length) throw new Error("Record query stale");
      return {
        records: ids.map((id) => byId.get(id)!),
        total: resultIds.length,
        offset,
        limit,
        hasMore: offset + limit < resultIds.length,
        calc: session.calc,
      };
    },
    status(id: string) {
      sweep();
      const cursor = direct.get(id);
      if (cursor) {
        cursor.touched = Date.now();
        return {
          id,
          revision: cursor.revision,
          total: cursor.total,
          calc: {},
          partitions: {},
          range: { min: null, max: null },
          protocol: 2 as const,
          mode: "cursor" as const,
          statistics: "complete" as const,
          totalExact: true,
        };
      }
      const indexed = sessions.get(id);
      if (indexed) {
        indexed.touched = Date.now();
        return {
          id,
          revision: indexed.revision,
          total: indexed.ids.length,
          calc: indexed.calc,
          partitions: Object.fromEntries(
            [...indexed.partitions].map(([key, ids]) => [key, ids.length]),
          ),
          range: indexed.range,
          protocol: 2 as const,
          mode: "index" as const,
          statistics: "complete" as const,
          totalExact: true,
        };
      }
      const state = streams.get(id);
      if (!state) throw new Error("Record query stale");
      if (state.error) throw state.error;
      state.touched = Date.now();
      return describe(id, state);
    },
    locate(id: string, recordId: string) {
      sweep();
      const streaming = streams.get(id);
      if (streaming) {
        if (streaming.error) throw streaming.error;
        return streaming.ids.indexOf(recordId);
      }
      const cursorSession = direct.get(id);
      if (cursorSession) {
        const row = db
          .query(
            "SELECT order_key,id FROM records WHERE id=? AND database_id=? AND __deleted=0",
          )
          .get(recordId, cursorSession.databaseId) as {
          order_key: string | null;
          id: string;
        } | null;
        if (!row) return -1;
        const before =
          row.order_key === null
            ? "(order_key IS NOT NULL OR (order_key IS NULL AND id < ?))"
            : "order_key IS NOT NULL AND (order_key < ? OR (order_key = ? AND id < ?))";
        const args =
          row.order_key === null
            ? [row.id]
            : [row.order_key, row.order_key, row.id];
        return (
          db
            .query(
              `SELECT count(*) AS n FROM records WHERE database_id=? AND __deleted=0 AND (${before})`,
            )
            .get(cursorSession.databaseId, ...args) as { n: number }
        ).n;
      }
      const session = sessions.get(id);
      if (!session) throw new Error("Record query stale");
      return session.ids.indexOf(recordId);
    },
    close(id: string) {
      if (id.startsWith("owner:")) {
        owners.delete(id.slice(6));
        for (const [key, state] of streams)
          if (state.owner === id.slice(6)) streams.delete(key);
      } else {
        sessions.delete(id);
        direct.delete(id);
        streams.delete(id);
      }
    },
    clear() {
      generation++;
      sessions.clear();
      direct.clear();
      streams.clear();
      owners.clear();
    },
  };
}

/** Reference pickers only need document summaries; never hydrate their bodies. */
export function queryDocuments(
  db: DbDriver,
  query: { search?: string; offset?: number; limit?: number } = {},
) {
  const limit = Number.isFinite(query.limit)
    ? Math.max(1, Math.min(200, Math.floor(query.limit!)))
    : 60;
  const offset = Number.isFinite(query.offset)
    ? Math.max(0, Math.floor(query.offset!))
    : 0;
  const needle = `%${(query.search ?? "").trim().replace(/[\\%_]/g, "\\$&")}%`;
  const where =
    "__deleted = 0 AND (title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
  const total = (
    db
      .query(`SELECT count(*) AS n FROM documents WHERE ${where}`)
      .get(needle, needle) as { n: number }
  ).n;
  const documents = db
    .query(
      `SELECT id, title, database_id, parent_id, created_hlc, order_key FROM documents WHERE ${where} ORDER BY order_key IS NULL, order_key, id LIMIT ? OFFSET ?`,
    )
    .all(
      needle,
      needle,
      limit,
      offset,
    ) as import("../../core/documents.ts").DocumentSummary[];
  return { documents, total, hasMore: total > offset + limit, offset, limit };
}
