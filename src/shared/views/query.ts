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
  if(indexOnly && !sort.length && !query.search?.trim() && !query.filter?.rules.length && !query.group && !query.dates && !calculations.length) {
    const keys=[...new Set(Object.values(query.partitions ?? {}))];
    const projection=keys.length ? `json_object(${keys.map(()=> '?,json_extract(data,?)').join(',')})` : "'{}'";
    const fields=keys.flatMap(id=>[id,`$.${JSON.stringify(id)}`]);
    const records:RecordRow[]=[];
    let cursor:{order_key:string|null;id:string}|null=null;
    for(;;) {
      const after=!cursor?'':cursor.order_key===null?' AND order_key IS NULL AND id > ?':' AND (order_key IS NULL OR order_key > ? OR (order_key = ? AND id > ?))';
      const args=!cursor?[]:cursor.order_key===null?[cursor.id]:[cursor.order_key,cursor.order_key,cursor.id];
      const chunk=db.query(`SELECT id,order_key,${projection} AS data FROM records WHERE database_id=? AND __deleted=0${after} ORDER BY order_key IS NULL,order_key,id LIMIT 200`).all(...fields,databaseId,...args) as {id:string;order_key:string|null;data:string}[];
      for(const row of chunk)records.push({id:row.id,database_id:databaseId,cells:JSON.parse(row.data),values:{}});
      if(chunk.length<200)break;
      cursor=chunk[chunk.length-1]!;yield;
    }
    return {records,total:records.length,calc:{},hasMore:false,offset:0,limit:records.length};
  }
  // Manual-order lists can page directly through the index. Scanning and
  // parsing every record on every scroll page is unnecessary without predicates.
  if (
    !indexOnly && !sort.length &&
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
  const retained: RecordRow[] = [];
  let total = 0;
  let cursor: { order_key: string | null; id: string } | null = null;
  for (;;) {
    const after = !cursor ? "" : cursor.order_key === null
      ? " AND order_key IS NULL AND id > ?"
      : " AND (order_key IS NULL OR order_key > ? OR (order_key = ? AND id > ?))";
    const args = !cursor ? [] : cursor.order_key === null
      ? [cursor.id] : [cursor.order_key, cursor.order_key, cursor.id];
    const chunk = db
      .query(
        `SELECT id, database_id, data, order_key FROM records WHERE database_id = ? AND __deleted = 0${after} ORDER BY order_key IS NULL, order_key, id LIMIT 200`,
      )
      .all(databaseId, ...args) as {
      id: string;
        order_key: string | null;
      database_id: string;
      data: string;
    }[];
    for (const row of chunk) {
      const raw = JSON.parse(row.data || "{}") as Record<string, unknown>;
      const cells: Record<string, unknown> = {},
        values: Record<string, unknown> = {};
      for (const prop of props)
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
        retained.push({ ...rec, values: {}, cells: Object.fromEntries([...new Set([...sort.map(({prop})=>prop.id), ...Object.values(query.partitions ?? {})])].map(id => [id, rec.cells[id]])) });
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
    let source = retained.slice(), target = new Array<RecordRow>(source.length);
    for (let width = 1; sort.length && width < source.length; width *= 2) {
      for (let base = 0; base < source.length; base += width * 2) {
        let left = base, right = Math.min(base + width, source.length);
        const middle = right, end = Math.min(base + width * 2, source.length);
        for (let out = base; out < end; out++) {
          target[out] = left < middle && (right >= end || compare(source[left]!, source[right]!) <= 0)
            ? source[left++]! : source[right++]!;
          if ((out + 1) % 4096 === 0) yield;
        }
      }
      [source, target] = [target, source];
    }
    return { records: source, calc: statistics(), total, hasMore: false, offset: 0, limit: total };
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
export function createRecordQuerySessions(db: DbDriver, revision: () => number) {
  const sessions = new Map<string, { databaseId: string; revision: number; ids: string[]; partitions: Map<string,string[]>; calc: Record<string, string>; touched: number }>();
  let serial = 0, generation = 0;
  const owners=new Map<string,number>();
  const sweep = () => {
    for (const [id, session] of sessions)
      if (Date.now() - session.touched > 300_000 || session.revision !== revision()) sessions.delete(id);
  };
  return {
    async open(databaseId: string, query: RecordQuery = {}, isCurrent = () => true) {
      const version = revision(), epoch = generation;
      const ownerEpoch=query.owner ? (owners.get(query.owner)??0)+1 : 0;
      if(query.owner)owners.set(query.owner,ownerEpoch);
      const scan = scanRecords(db, databaseId, query, true);
      for (;;) {
        if (!isCurrent() || generation !== epoch || (query.owner && owners.get(query.owner)!==ownerEpoch)) throw new Error("Replica query cancelled");
        if (revision() !== version) throw new Error("Record query stale");
        const step = scan.next();
        if (step.done) {
          sweep();
          while (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
          const id = `query_${++serial}`;
          const { records, calc, total } = step.value;
          const partitions = new Map<string,string[]>();
          const add = (key:string, rid:string) => { const ids=partitions.get(key) ?? []; ids.push(rid); partitions.set(key,ids); };
          const fields=listProperties(db,databaseId);
          const group=fields.find(p=>p.id===query.partitions?.group);
          let min:string|null=null,max:string|null=null;
          for(const row of records) {
            if(group) {
              const raw=row.cells[group.id],options=group.config?.options ?? [];
              const keys=[...new Set((Array.isArray(raw)?raw:[raw]).filter(v=>typeof v==='string' && options.includes(v)))];
              for(const key of keys.length?keys:[null]) add(`group:${JSON.stringify(key)}`,row.id);
            }
            if(query.partitions?.date) {
              const date=parseDate(row.cells[query.partitions.date]);
              const iso=date ? `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` : '';
              add(`date:${iso}`,row.id);
              if(iso) {
                add("date:scheduled",row.id);
                const end=query.partitions.end ? parseDate(row.cells[query.partitions.end]) : null;
                const last=end && end>date! ? `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}` : iso;
                if(!min || iso<min)min=iso;
                if(!max || last>max)max=last;
              }
            }
          }
          sessions.set(id, { databaseId, revision: version, ids: records.map(r => r.id), partitions, calc, touched: Date.now() });
          return { id, revision: version, total, calc, partitions:Object.fromEntries([...partitions].map(([key,ids])=>[key,ids.length])), range:{min,max} };
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    },
    page(id: string, offset = 0, limit = 100, partition?: string) {
      sweep();
      const session = sessions.get(id);
      if (!session) throw new Error("Record query stale");
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid record query window");
      session.touched = Date.now();
      const resultIds = partition == null ? session.ids : (session.partitions.get(partition) ?? []);
      const ids = resultIds.slice(offset, offset + limit);
      const props = listProperties(db, session.databaseId);
      const rows = ids.length ? db.query(`SELECT id, data FROM records WHERE database_id = ? AND __deleted = 0 AND id IN (${ids.map(() => "?").join(",")})`).all(session.databaseId, ...ids) as { id: string; data: string }[] : [];
      const byId = new Map(rows.map(row => {
        const raw = JSON.parse(row.data || "{}"), cells: Record<string, unknown> = {}, values: Record<string, unknown> = {};
        for (const prop of props) if (Object.hasOwn(raw, prop.id)) {
          cells[prop.id] = raw[prop.id]; values[prop.name] = raw[prop.id];
        }
        return [row.id, { id: row.id, database_id: session.databaseId, cells, values }] as const;
      }));
      if (byId.size !== ids.length) throw new Error("Record query stale");
      return { records: ids.map(id => byId.get(id)!), total: resultIds.length, offset, limit, hasMore: offset + limit < resultIds.length, calc: session.calc };
    },
    locate(id: string, recordId: string) {
      sweep();
      const session = sessions.get(id);
      if (!session) throw new Error("Record query stale");
      return session.ids.indexOf(recordId);
    },
    close(id: string) { if(id.startsWith("owner:"))owners.delete(id.slice(6));else sessions.delete(id); },
    clear() { generation++; sessions.clear(); owners.clear(); },
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
