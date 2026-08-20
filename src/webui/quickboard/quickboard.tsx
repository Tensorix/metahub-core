/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, type Db, type Prop, type Rec } from "../api.ts";
import { Icon } from "../icons.tsx";
import { BoardView } from "../board.tsx";
import { RecordPeek } from "../table.tsx";
import { imeGhost } from "../keys.ts";
import { SYNCED_EVENT } from "../data/replica.ts";
import { UiHost, openMenu, MenuItem, MenuLabel } from "../ui.tsx";

// The Quick Board window: the desktop's at-a-glance task board, mounted from
// the shared webui bundle when the URL hash is `#board` (see app.tsx) — the
// board twin of the Quick Notes window (quicknote/quicknote.tsx). It renders
// the existing BoardView over one database and stays fresh through the live
// change feed (live.ts → SYNCED_EVENT), so an agent driving `mh record update`
// moves cards here within a second or two. Which database/group to show is a
// machine-local choice (localStorage) — core and server know nothing about
// quick boards.

const DB_KEY = "mh-quickboard-db";
const groupKey = (dbId: string): string => `mh-quickboard-group:${dbId}`;

export function QuickBoard() {
  const [dbs, setDbs] = useState<Db[]>([]);
  const [db, setDb] = useState<Db | null>(null);
  const [props, setProps] = useState<Prop[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pinned, setPinned] = useState(false);

  const qb = typeof window !== "undefined" ? window.metahubDesktop?.quickboard : undefined;
  const dbRef = useRef(db);
  dbRef.current = db;

  const guard = (fn: () => Promise<void>) => fn().catch((e) => setError(String(e.message)));

  const reload = useCallback(async (dbId: string): Promise<void> => {
    const [p, r] = await Promise.all([api.listProperties(dbId), api.listRecords(dbId)]);
    setProps(p);
    setRecords(r);
    setLoaded(true);
  }, []);

  /** Pick the active database: the remembered one if it still exists, else the
   *  first. Passing `id` (menu click) also persists the choice. */
  const selectDb = useCallback(
    async (list: Db[], id?: string): Promise<void> => {
      const remembered = id ?? localStorage.getItem(DB_KEY) ?? undefined;
      const target = list.find((d) => d.id === remembered) ?? list[0] ?? null;
      setDb(target);
      setPeekId(null);
      setLoaded(false);
      if (!target) {
        setProps([]);
        setRecords([]);
        setLoaded(true); // nothing to load — let the empty state show
        return;
      }
      localStorage.setItem(DB_KEY, target.id);
      setGroup(localStorage.getItem(groupKey(target.id)));
      await reload(target.id);
    },
    [reload],
  );

  useEffect(() => {
    guard(async () => {
      const list = await api.listDatabases();
      setDbs(list);
      await selectDb(list);
    });
  }, [selectDb]);

  // Live refresh: the change feed (live.ts) rebroadcasts server pokes as
  // SYNCED_EVENT. Records/properties → re-read the open board (skipped
  // mid-drag so a poke never yanks a card out from under the pointer);
  // databases → refresh the switcher list and drop/reselect if ours vanished.
  useEffect(() => {
    const onSynced = (e: Event) => {
      const detail = (e as CustomEvent).detail as { datasets?: string[] } | undefined;
      if (!detail?.datasets) return;
      if (detail.datasets.includes("databases")) {
        guard(async () => {
          const list = await api.listDatabases();
          setDbs(list);
          const cur = dbRef.current;
          if (!cur || !list.some((d) => d.id === cur.id)) await selectDb(list);
        });
      }
      if (!detail.datasets.some((d) => d === "records" || d === "properties")) return;
      if (document.body.classList.contains("table-dragging")) return;
      const cur = dbRef.current;
      if (cur) reload(cur.id).catch(() => {});
    };
    document.addEventListener(SYNCED_EVENT, onSynced);
    return () => document.removeEventListener(SYNCED_EVENT, onSynced);
  }, [reload, selectDb]);

  // The main window's 浮窗看板 button targets a specific database: it persists
  // the choice (for a cold mount) and broadcasts it here so an already-warm
  // hidden window switches before it is revealed (sender in table.tsx; the
  // Electron windows are same-origin, so BroadcastChannel crosses them).
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("mh-quickboard");
    ch.onmessage = (e: MessageEvent) => {
      const dbId = (e.data as { dbId?: string } | null)?.dbId;
      if (!dbId || dbId === dbRef.current?.id) return;
      guard(async () => {
        const list = await api.listDatabases();
        setDbs(list);
        await selectDb(list, dbId);
      });
    };
    return () => ch.close();
  }, [selectDb]);

  // Reflect the persisted always-on-top state on the pin button.
  useEffect(() => {
    qb?.getAlwaysOnTop().then(setPinned).catch(() => {});
  }, [qb]);

  // Esc hides the window (it stays alive in the background for instant
  // reopen). Only an UNCONSUMED Escape — menus/peek close themselves with
  // consumeKey, and an IME candidate-cancel belongs to the composition.
  useEffect(() => {
    if (!qb) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || imeGhost(e)) return;
      void qb.hide();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [qb]);

  // Optimistic cell commit + background reconcile — same shape as the main
  // table view's commit (table.tsx).
  const commit = (rec: Rec, prop: Prop, value: unknown) => {
    setRecords((rs) =>
      rs.map((r) =>
        r.id === rec.id
          ? { ...r, cells: { ...r.cells, [prop.id]: value }, values: { ...r.values, [prop.name]: value } }
          : r,
      ),
    );
    api.updateRecord(rec.id, { [prop.id]: value })
      .then((updated) => setRecords((rs) => rs.map((r) => (r.id === updated.id ? updated : r))))
      .catch((e) => {
        setError(String(e.message));
        if (dbRef.current) reload(dbRef.current.id).catch(() => {});
      });
  };

  const createWith = (values: Record<string, unknown>) =>
    guard(async () => {
      if (!dbRef.current) return;
      const rec = await api.createRecord(dbRef.current.id, values);
      setRecords((rs) => [...rs, rec]);
    });

  const move = (srcId: string, targetId: string, where: "before" | "after") => {
    if (srcId === targetId) return;
    api.moveRecord(srcId, targetId, where).catch((e) => {
      setError(String(e.message));
      if (dbRef.current) reload(dbRef.current.id).catch(() => {});
    });
  };

  const togglePin = async () => {
    if (!qb) return;
    const next = !pinned;
    setPinned(next);
    try {
      setPinned(await qb.setAlwaysOnTop(next));
    } catch {
      setPinned(!next);
    }
  };

  const openDbMenu = (e: MouseEvent) => {
    openMenu(
      e,
      (close) => (
        <>
          <MenuLabel>切换数据库</MenuLabel>
          {dbs.length === 0 && <div class="lbl">还没有数据库</div>}
          {dbs.map((d) => (
            <MenuItem
              key={d.id}
              icon="table"
              label={d.name}
              checked={d.id === db?.id}
              onClick={() => {
                close();
                void guard(() => selectDb(dbs, d.id));
              }}
            />
          ))}
        </>
      ),
      { minWidth: 220 },
    );
  };

  const onGroupChange = (id: string) => {
    setGroup(id);
    if (db) localStorage.setItem(groupKey(db.id), id);
  };

  const peekRec = peekId ? records.find((r) => r.id === peekId) ?? null : null;

  return (
    <div class="qb">
      <div class="qb-bar">
        <button class="qb-brand" onClick={openDbMenu} title="切换数据库">
          {db?.name ?? "快速看板"}
          <Icon name="chevronDown" cls="ico sm" />
        </button>
        <div class="qb-actions">
          <button class="iconbtn" title="新建记录" onClick={() => void createWith({})}>
            <Icon name="plus" />
          </button>
          {qb && (
            <button
              class={"iconbtn" + (pinned ? " active" : "")}
              title={pinned ? "取消置顶" : "始终置顶"}
              onClick={() => void togglePin()}
            >
              <Icon name="pin" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div class="error-bar" onClick={() => setError("")}>
          ⚠ {error}（点击关闭）
        </div>
      )}

      <div class="qb-body">
        {db && loaded ? (
          <BoardView
            props={props}
            records={records}
            onCommitValue={commit}
            onCreate={createWith}
            onOpenRecord={setPeekId}
            onMove={move}
            group={group}
            onGroupChange={onGroupChange}
          />
        ) : (
          <div class="empty">
            <div>{loaded ? "还没有数据库 — 在主窗口创建一个后再打开看板。" : "加载中…"}</div>
          </div>
        )}
      </div>

      {db && peekRec && (
        <RecordPeek
          db={db}
          props={props}
          rec={peekRec}
          onClose={() => setPeekId(null)}
          onCommit={(p, v) => commit(peekRec, p, v)}
          onDelete={() =>
            guard(async () => {
              await api.deleteRecord(peekRec.id);
              setRecords((rs) => rs.filter((r) => r.id !== peekRec.id));
              setPeekId(null);
            })
          }
          onDuplicate={() =>
            guard(async () => {
              const copy = await api.createRecord(db.id, peekRec.cells);
              setRecords((rs) => {
                const i = rs.findIndex((r) => r.id === peekRec.id);
                return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)];
              });
            })
          }
          onReverted={() => reload(db.id).catch((e) => setError(String(e.message)))}
          onRelCreated={(p) => {
            if (p.config?.database === db.id) reload(db.id).catch(() => {});
          }}
        />
      )}

      <UiHost />
    </div>
  );
}
