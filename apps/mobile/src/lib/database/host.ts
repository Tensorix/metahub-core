import { normalizeViews } from "../../../../../src/shared/views/model";
import {
  databaseViewQuery,
  databaseQueryKey,
} from "../../../../../src/shared/views/database-view-query";
import type { RecordQuery } from "../../../../../src/shared/views/query";
import type { ReplicaService } from "../../../../../src/core/replica/service";
import {
  recordWriter,
  prepareCell,
  withRecordDrafts,
} from "../database-drafts";
export function createDatabaseHost(
  service: ReplicaService,
  databaseId: string,
  current: () => boolean,
  capabilities: {
    openRecord(id: string): void;
    clipboardWrite(text: string): Promise<void>;
    clipboardRead(): Promise<string>;
    openDocument?(id: string): void;
    openLink?(url: string): Promise<unknown>;
  },
) {
  const allowed = new Set([
    "recordQueryStatus",
    "listDatabases",
    "listProperties",
    "listRecords",
    "getRecord",
    "createRecord",
    "updateRecord",
    "deleteRecord",
    "moveRecord",
    "createProperty",
    "updateProperty",
    "deleteProperty",
    "renameSelectOption",
    "removeSelectOption",
    "updateDatabase",
    "listDocuments",
    "createDocument",
    "referenceSummaries",
    "openRecordQuery",
    "readRecordQuery",
    "closeRecordQuery",
    "locateRecordQuery",
    "moveProperty",
    "moveSelectOption",
    "recordHistory",
    "recordAt",
    "recordFieldHistory",
    "revertRecord",
    "auditList",
    "auditRevert",
  ]);
  const touched = new Set<string>();
  const queries = new Set<string>();
  const owners = new Set<string>();
  let epoch = 0;
  type Prepared = {
    index: Awaited<ReturnType<typeof service.client.openRecordQuery>>;
    page?: Awaited<ReturnType<typeof service.client.readRecordQuery>>;
  };
  let opening: { key: string; result: Promise<Prepared> } | null = null;
  let firstPage: Prepared | null = null;
  const releaseQueries = async () => {
    epoch++;
    opening = null;
    firstPage = null;
    const closing = [...queries, ...owners];
    queries.clear();
    owners.clear();
    knownRecords.clear();
    revisions.clear();
    await Promise.all(closing.map((id) => service.client.closeRecordQuery(id)));
  };
  const revisions = new Map<string, number>();
  const knownRecords = new Set<string>();
  const preferencePrefix = `database:${databaseId}:`;
  const overlay = (row: any) => {
    knownRecords.add(row.id);
    if (knownRecords.size > 1000)
      knownRecords.delete(knownRecords.values().next().value!);
    return withRecordDrafts(service, row);
  };
  const overlayPage = (rows: any[]) => {
    const recovered = service.drafts.recordsWithDrafts(
      rows.map((row) => row.id),
    );
    return rows.map((row) => {
      if (recovered.has(row.id)) recordWriter(service, row.id);
      return overlay(row);
    });
  };
  const flush = async () => {
    if (![...touched].some((id) => recordWriter(service, id).drafts.dirty))
      return;
    const props = await service.client.listProperties(databaseId);
    for (const id of touched) {
      const result = await recordWriter(service, id).drafts.flush(
        (pid, value) => prepareCell(props, pid, value),
      );
      if (!result.ok) throw new Error(result.error);
    }
  };
  return {
    flush,
    releaseQueries,
    async metadata() {
      const [rows, props] = await Promise.all([
        service.client.listDatabases(),
        service.client.listProperties(databaseId),
      ]);
      if (!current()) throw new Error("工作区已切换");
      const db = rows.find((r) => r.id === databaseId);
      if (!db) throw new Error("数据表已删除");
      return { db, props };
    },
    async prepareOpening(requestedView?: string) {
      const requestEpoch = epoch;
      const metadata = await this.metadata();
      if (requestEpoch !== epoch) throw new Error("Replica query cancelled");
      const views = normalizeViews(metadata.db.meta?.views);
      const preferred =
        service.drafts.readPreferences(preferencePrefix)[
          "mh.db.view." + databaseId
        ];
      const view =
        views.find(
          (v) => v.id === requestedView || v.layout === requestedView,
        ) ??
        views.find((v) => v.id === preferred) ??
        views[0]!;
      const query = databaseViewQuery(view, metadata.props),
        owner = "opening:" + databaseId;
      owners.add("owner:" + owner);
      const result = service.client
        .openRecordQuery(databaseId, { ...query, protocol: 2, owner })
        .then(async (index) => {
          if (requestEpoch !== epoch) {
            await service.client.closeRecordQuery(index.id);
            throw new Error("Replica query cancelled");
          }
          queries.add(index.id);
          const page =
            view.layout === "table"
              ? await service.client.readRecordQuery(index.id, 0, 100)
              : undefined;
          return { index, page };
        });
      void result.catch(() => {});
      opening = { key: databaseQueryKey(query), result };
      return metadata;
    },
    preferences: () => service.drafts.readPreferences(preferencePrefix),
    async call(method: string, args: unknown[]) {
      if (!current()) throw new Error("工作区已切换");
      if (method === "releaseQueries") {
        await releaseQueries();
        return null;
      }
      if (method === "openRecordQuery") {
        const owner = (args[1] as any)?.owner;
        if (owner) owners.add("owner:" + owner);
      }
      const requestEpoch = epoch;
      if (method === "preference") {
        if (
          typeof args[0] !== "string" ||
          args[0].length > 200 ||
          (args[1] !== null && typeof args[1] !== "string")
        )
          throw new Error("Invalid preference");
        service.drafts.setPreference(
          preferencePrefix + args[0],
          args[1] as string | null,
        );
        return null;
      }
      if (method === "flush") {
        await flush();
        return null;
      }
      if (method === "checkpoint") {
        const id = String(args[0]),
          pid = String(args[1]),
          revision = args[3],
          key = id + ":" + pid;
        if (
          typeof revision !== "number" ||
          !Number.isSafeInteger(revision) ||
          revision < 1
        )
          throw new Error("Invalid draft revision");
        if (revision <= (revisions.get(key) ?? 0))
          return { revision: revisions.get(key) };
        if (!knownRecords.has(id)) {
          const row = await service.client.getRecord(id);
          if (row.database_id !== databaseId)
            throw new Error("记录不属于当前数据表");
          knownRecords.add(id);
        }
        // Preserve recovery text even if a concurrent sync deleted the field/record.
        if (!current()) throw new Error("工作区已切换");
        if (requestEpoch !== epoch) throw new Error("Replica query cancelled");
        touched.add(id);
        recordWriter(service, id).drafts.stage(pid, args[2]);
        const saved = service.drafts.readFields(id)[pid];
        if (!saved || JSON.stringify(saved.value) !== JSON.stringify(args[2]))
          throw new Error("草稿尚未持久化，请重试");
        revisions.set(key, revision);
        return { revision };
      }
      if (method === "discardCheckpoint") {
        const id = String(args[0]),
          pid = String(args[1]),
          drafts = recordWriter(service, id).drafts;
        const draft = drafts.fields.get(pid);
        if (draft) {
          service.drafts.acknowledgeField(id, pid, draft.value);
          drafts.fields.delete(pid);
        }
        return null;
      }
      if (method === "openDocument") {
        await flush();
        if (requestEpoch !== epoch) throw new Error("Replica query cancelled");
        capabilities.openDocument?.(String(args[0]));
        return null;
      }
      if (method === "openLink") {
        const url = String(args[0]);
        if (!/^https?:\/\//.test(url)) throw new Error("不支持此链接");
        await flush();
        await capabilities.openLink?.(url);
        return null;
      }
      if (method === "clipboardWrite") {
        if (typeof args[0] !== "string") throw new Error("Invalid clipboard");
        return capabilities.clipboardWrite(args[0]);
      }
      if (method === "clipboardRead") return capabilities.clipboardRead();
      if (method === "openRecord") {
        await flush();
        if (typeof args[0] !== "string") throw new Error("Invalid record");
        await service.client.getRecord(args[0]);
        if (requestEpoch !== epoch) throw new Error("Replica query cancelled");
        capabilities.openRecord(args[0]);
        return null;
      }
      if (method === "listShares" || method === "listLocalShares") return [];
      if (method === "setColumnWidth") {
        method = "updateProperty";
        args = [args[0], { config: { width: args[1] } }];
      }
      if (!allowed.has(method)) throw new Error(`此操作暂不支持：${method}`);
      if (["updateRecord", "deleteRecord", "moveRecord"].includes(method)) {
        const row = await service.client.getRecord(String(args[0]));
        if (row.database_id !== databaseId)
          throw new Error("记录不属于当前数据表");
      }
      if (
        [
          "updateProperty",
          "deleteProperty",
          "renameSelectOption",
          "removeSelectOption",
          "moveProperty",
          "moveSelectOption",
        ].includes(method)
      ) {
        const props = await service.client.listProperties(databaseId);
        if (!props.some((p) => p.id === args[0]))
          throw new Error("字段不属于当前数据表");
      }
      if (method === "updateDatabase" && args[0] !== databaseId)
        throw new Error("数据表不匹配");
      if (method === "createRecord" && args[0] !== databaseId)
        throw new Error("数据表不匹配");
      if (method === "createProperty" && (args[0] as any)?.db !== databaseId)
        throw new Error("数据表不匹配");
      if (method === "updateRecord") {
        const id = String(args[0]),
          patch = args[1];
        if (!patch || typeof patch !== "object" || Array.isArray(patch))
          throw new Error("Invalid record patch");
        const props = await service.client.listProperties(databaseId);
        if (!current()) throw new Error("工作区已切换");
        if (requestEpoch !== epoch) throw new Error("Replica query cancelled");
        const drafts = recordWriter(service, id).drafts;
        touched.add(id);
        for (const [pid, value] of Object.entries(patch)) {
          if (!props.some((p) => p.id === pid)) throw new Error("字段已删除");
          drafts.stage(pid, value);
        }
        const result = await drafts.flush((pid, value) =>
          prepareCell(props, pid, value),
        );
        if (!result.ok) throw new Error(result.error);
        return withRecordDrafts(service, await service.client.getRecord(id));
      }
      const fn = (
        service.client as unknown as Record<
          string,
          (...args: unknown[]) => Promise<unknown>
        >
      )[method];
      if (!fn) throw new Error("Unsupported host method");
      if (!current()) throw new Error("工作区已切换");
      if (requestEpoch !== epoch) throw new Error("Replica query cancelled");
      let result: unknown;
      const prepared =
        method === "openRecordQuery" &&
        opening?.key === databaseQueryKey(args[1] as RecordQuery)
          ? opening
          : null;
      if (prepared) {
        opening = null;
        try {
          const ready = await prepared.result;
          await service.client.recordQueryStatus(ready.index.id);
          firstPage = ready;
          result = ready.index;
        } catch {
          if (requestEpoch !== epoch)
            throw new Error("Replica query cancelled");
          result = await fn(...args);
        }
      } else if (
        method === "readRecordQuery" &&
        firstPage &&
        firstPage.index.id === args[0] &&
        (args[1] ?? 0) === 0 &&
        (args[2] ?? 100) === 100 &&
        args[3] == null &&
        firstPage.page
      ) {
        await service.client.recordQueryStatus(firstPage.index.id);
        result = firstPage.page;
        firstPage = null;
      } else result = await fn(...args);
      if (method === "openRecordQuery") {
        if (requestEpoch !== epoch) {
          await service.client.closeRecordQuery((result as any).id);
          throw new Error("Replica query cancelled");
        }
        queries.add((result as any).id);
      }
      if (method === "closeRecordQuery") queries.delete(String(args[0]));
      if (!current()) throw new Error("工作区已切换");
      if (requestEpoch !== epoch) throw new Error("Replica query cancelled");
      if (method === "listRecords") return overlayPage(result as any[]);
      if (method === "getRecord") return overlayPage([result])[0];
      if (method === "readRecordQuery") {
        const page = result as any;
        return { ...page, records: overlayPage(page.records) };
      }
      return result;
    },
  };
}
