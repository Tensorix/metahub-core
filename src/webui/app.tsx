/** @jsxImportSource preact */
import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

// Single-file Preact app: browse databases/records and documents, light editing.
// All writes go through the /api/* routes, which call the same core functions
// the CLI uses, so changes land in the CRDT oplog and replicate over /sync.

// --- tiny API client --------------------------------------------------------

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  }
  return data;
}
const api = {
  get: (p: string) => req("GET", p),
  post: (p: string, b: unknown) => req("POST", p, b),
  patch: (p: string, b: unknown) => req("PATCH", p, b),
  del: (p: string) => req("DELETE", p),
};

// --- minimal markdown -> html for the document preview ----------------------

function mdToHtml(src: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (t: string) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = src.split("\n");
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      closeList();
      let code = "";
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code += lines[i++] + "\n";
      html += `<pre><code>${esc(code)}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      closeList();
      const n = h[1]!.length;
      html += `<h${n}>${inline(h[2]!)}</h${n}>`;
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(li[1]!)}</li>`;
      continue;
    }
    closeList();
    if (line.trim() !== "") html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

// --- types (loose) ----------------------------------------------------------

type Db = { id: string; name: string; icon: string | null };
type Prop = { id: string; name: string; type: string; config: any };
type Rec = { id: string; database_id: string; values: Record<string, any> };
type DocSummary = { id: string; title: string; database_id: string | null };
type Doc = DocSummary & { body: string | null };
type Hit = { type: string; id: string; database_id: string | null; title?: string; snippet: string };
type View =
  | { kind: "db"; id: string }
  | { kind: "doc"; id: string }
  | { kind: "search"; q: string }
  | { kind: "empty" };

// --- record cell ------------------------------------------------------------

function display(prop: Prop, v: any) {
  if (v === undefined || v === null || v === "") return <span className="muted">—</span>;
  if (prop.type === "checkbox") return <span>{v ? "✓" : "✗"}</span>;
  if (Array.isArray(v)) return <>{v.map((x) => <span className="chip">{String(x)}</span>)}</>;
  if (prop.type === "url")
    return <a href={String(v)} target="_blank" rel="noreferrer">{String(v)}</a>;
  return <span>{String(v)}</span>;
}

function Cell({ prop, value, onCommit }: { prop: Prop; value: any; onCommit: (v: any) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (prop.type === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={!!value}
        style="margin:8px"
        onChange={(e) => onCommit((e.target as HTMLInputElement).checked)}
      />
    );
  }

  if (!editing) {
    return (
      <div className="cell" onClick={() => {
        setDraft(Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value));
        setEditing(true);
      }}>
        {display(prop, value)}
      </div>
    );
  }

  const commit = (raw: string) => {
    setEditing(false);
    let out: any = raw;
    if (prop.type === "multi_select" || prop.type === "relation")
      out = raw.split(",").map((s) => s.trim()).filter(Boolean);
    onCommit(out);
  };

  if (prop.type === "select") {
    const opts: string[] = prop.config?.options ?? [];
    return (
      <select
        autofocus
        value={value ?? ""}
        onChange={(e) => commit((e.target as HTMLSelectElement).value)}
        onBlur={() => setEditing(false)}
      >
        <option value=""></option>
        {opts.map((o) => <option value={o}>{o}</option>)}
      </select>
    );
  }

  return (
    <input
      autofocus
      value={draft}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={(e) => commit((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

// --- table view -------------------------------------------------------------

function TableView({ dbId, onError }: { dbId: string; onError: (e: string) => void }) {
  const [props, setProps] = useState<Prop[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        api.get<Prop[]>(`/api/properties?db=${encodeURIComponent(dbId)}`),
        api.get<Rec[]>(`/api/records?db=${encodeURIComponent(dbId)}`),
      ]);
      setProps(p);
      setRecords(r);
    } catch (e) {
      onError(String((e as Error).message));
    }
  }, [dbId]);

  useEffect(() => void load(), [load]);

  const commitCell = async (recId: string, prop: Prop, value: any) => {
    try {
      const updated = await api.patch<Rec>(`/api/record?id=${encodeURIComponent(recId)}`, {
        [prop.name]: value,
      });
      setRecords((rs) => rs.map((r) => (r.id === recId ? updated : r)));
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const newRow = async () => {
    try {
      const rec = await api.post<Rec>(`/api/records?db=${encodeURIComponent(dbId)}`, {});
      setRecords((rs) => [...rs, rec]);
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const delRow = async (id: string) => {
    if (!confirm("Delete this record?")) return;
    try {
      await api.del(`/api/record?id=${encodeURIComponent(id)}`);
      setRecords((rs) => rs.filter((r) => r.id !== id));
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const addProp = async (name: string, type: string) => {
    try {
      await api.post(`/api/properties`, { db: dbId, name, type });
      setAdding(false);
      await load();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  return (
    <div>
      <div className="row-actions">
        <button className="primary" onClick={newRow}>+ New record</button>
        <button onClick={() => setAdding((a) => !a)}>+ Add property</button>
        <span className="muted">{records.length} records · {props.length} properties</span>
      </div>
      {adding && <AddPropertyForm onAdd={addProp} onCancel={() => setAdding(false)} />}
      {props.length === 0 ? (
        <p className="muted">No properties yet. Add one to start.</p>
      ) : (
        <table>
          <thead>
            <tr>
              {props.map((p) => (
                <th>{p.name} <span className="muted" style="font-weight:400">{p.type}</span></th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr>
                {props.map((p) => (
                  <td>
                    <Cell
                      prop={p}
                      value={r.values[p.name]}
                      onCommit={(v) => commitCell(r.id, p, v)}
                    />
                  </td>
                ))}
                <td className="actions">
                  <button className="link" title="Delete" onClick={() => delRow(r.id)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AddPropertyForm({ onAdd, onCancel }: { onAdd: (n: string, t: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  return (
    <div className="row-actions">
      <input placeholder="Property name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      <select value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
        {["text", "number", "checkbox", "date", "url"].map((t) => <option value={t}>{t}</option>)}
      </select>
      <button className="primary" disabled={!name.trim()} onClick={() => onAdd(name.trim(), type)}>Add</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}

// --- document view ----------------------------------------------------------

function DocView({ docId, onChange, onError }: { docId: string; onChange: () => void; onError: (e: string) => void }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get<Doc>(`/api/document?id=${encodeURIComponent(docId)}`)
      .then((d) => {
        if (!alive) return;
        setDoc(d);
        setTitle(d.title ?? "");
        setBody(d.body ?? "");
        setDirty(false);
      })
      .catch((e) => onError(String(e.message)));
    return () => {
      alive = false;
    };
  }, [docId]);

  const save = async () => {
    try {
      await api.patch(`/api/document?id=${encodeURIComponent(docId)}`, { title, body });
      setDirty(false);
      onChange();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };
  const del = async () => {
    if (!confirm("Delete this document?")) return;
    try {
      await api.del(`/api/document?id=${encodeURIComponent(docId)}`);
      onChange();
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  if (!doc) return <p className="muted">Loading…</p>;
  return (
    <div>
      <div className="row-actions">
        <button className="primary" disabled={!dirty} onClick={save}>{dirty ? "Save" : "Saved"}</button>
        <button className="link" onClick={del}>Delete</button>
        <span className="muted">{doc.id}</span>
      </div>
      <div className="doc-editor">
        <div>
          <input
            className="title"
            value={title}
            onInput={(e) => { setTitle((e.target as HTMLInputElement).value); setDirty(true); }}
          />
          <textarea
            value={body}
            onInput={(e) => { setBody((e.target as HTMLTextAreaElement).value); setDirty(true); }}
          />
        </div>
        <div className="preview" dangerouslySetInnerHTML={{ __html: mdToHtml(body) }} />
      </div>
    </div>
  );
}

// --- search results ---------------------------------------------------------

function SearchView({ q, onOpen }: { q: string; onOpen: (h: Hit) => void }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => {
    setHits(null);
    api.get<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`).then(setHits).catch(() => setHits([]));
  }, [q]);
  if (hits === null) return <p className="muted">Searching…</p>;
  if (hits.length === 0) return <p className="muted">No results for “{q}”.</p>;
  return (
    <div>
      <h2 className="title">Results for “{q}”</h2>
      {hits.map((h) => (
        <div className="hit" onClick={() => onOpen(h)}>
          <strong>{h.title || h.id}</strong> <span className="muted">{h.type}</span>
          <div className="muted" dangerouslySetInnerHTML={{ __html: h.snippet }} />
        </div>
      ))}
    </div>
  );
}

// --- app shell --------------------------------------------------------------

function App() {
  const [dbs, setDbs] = useState<Db[]>([]);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  const reloadNav = useCallback(async () => {
    try {
      const [d, o] = await Promise.all([
        api.get<Db[]>("/api/databases"),
        api.get<DocSummary[]>("/api/documents"),
      ]);
      setDbs(d);
      setDocs(o);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);
  useEffect(() => void reloadNav(), [reloadNav]);

  const newDb = async () => {
    const name = prompt("New database name?");
    if (!name) return;
    try {
      const db = await api.post<Db>("/api/databases", { name });
      await reloadNav();
      setView({ kind: "db", id: db.id });
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  const newDoc = async () => {
    const title = prompt("New document title?");
    if (!title) return;
    try {
      const doc = await api.post<Doc>("/api/documents", { title });
      await reloadNav();
      setView({ kind: "doc", id: doc.id });
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const title = useMemo(() => {
    if (view.kind === "db") return dbs.find((d) => d.id === view.id)?.name ?? view.id;
    if (view.kind === "doc") return docs.find((d) => d.id === view.id)?.title ?? view.id;
    return "";
  }, [view, dbs, docs]);

  return (
    <>
      <div className="sidebar">
        <h1>📦 Metahub</h1>
        <div className="group">
          <div className="group-head">
            <span>Databases</span>
            <button className="link" title="New database" onClick={newDb}>+</button>
          </div>
          {dbs.map((d) => (
            <button
              className={"nav-item" + (view.kind === "db" && view.id === d.id ? " active" : "")}
              onClick={() => setView({ kind: "db", id: d.id })}
            >
              {d.icon ? d.icon + " " : "🗂 "}{d.name}
            </button>
          ))}
          {dbs.length === 0 && <div className="nav-item muted">none</div>}
        </div>
        <div className="group">
          <div className="group-head">
            <span>Documents</span>
            <button className="link" title="New document" onClick={newDoc}>+</button>
          </div>
          {docs.map((d) => (
            <button
              className={"nav-item" + (view.kind === "doc" && view.id === d.id ? " active" : "")}
              onClick={() => setView({ kind: "doc", id: d.id })}
            >
              📄 {d.title || d.id}
            </button>
          ))}
          {docs.length === 0 && <div className="nav-item muted">none</div>}
        </div>
      </div>

      <div className="main">
        <div className="topbar">
          <input
            className="search"
            placeholder="Search documents & records…"
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && search.trim()) setView({ kind: "search", q: search.trim() });
            }}
          />
        </div>
        {error && <div className="error" onClick={() => setError("")}>⚠ {error} (click to dismiss)</div>}
        {title && <h2 className="title">{title}</h2>}

        {view.kind === "empty" && <p className="muted">Select a database or document from the left.</p>}
        {view.kind === "db" && <TableView dbId={view.id} onError={setError} />}
        {view.kind === "doc" && (
          <DocView docId={view.id} onError={setError} onChange={() => { reloadNav(); }} />
        )}
        {view.kind === "search" && (
          <SearchView
            q={view.q}
            onOpen={(h) =>
              h.type === "document"
                ? setView({ kind: "doc", id: h.id })
                : h.database_id && setView({ kind: "db", id: h.database_id })
            }
          />
        )}
      </div>
    </>
  );
}

render(<App />, document.getElementById("app")!);
