metahub is a **local-first knowledge base** that gives an AI agent a durable, syncable working memory. Everything lives on your own disk under `~/.metahub/` and stays consistent across many machines.

## Core layers

The system is built as a small set of composable layers:

- **Storage** — a single SQLite database per hub, holding typed tables, documents, and an append-only oplog.
- **CRDT engine** — every write becomes an operation; documents merge at the *paragraph* level so concurrent edits never clobber each other.
- **Sync** — push/pull rounds move operations between nodes; a server is itself just another node.
- **Surfaces** — a CLI for agents, a browser WebUI for humans, and a REST + OpenAPI layer for programs.

> Design goal: an agent should be able to `Read → Edit → Write` its own memory with the same ergonomics a human gets in Notion.

## Data model

| Concept | Shape | Example id |
| --- | --- | --- |
| database | typed table, owns properties | `db_tasks-k3f9c1` |
| record | a row of typed cells | `rec_fix-login-7j02an` |
| document | ordered markdown blocks | `doc_arch-p91x2` |
| site | bucket of static files | `site_docs-a12b` |

## Editing contract

Reads return a body plus a **version token**. Writes send only the delta:

```ts
const { body, version } = await doc.read(ref);
await doc.edit(ref, {
  old: "old paragraph",
  new: "new paragraph",
  ifMatch: version,   // optimistic concurrency — stale writes are rejected
});
```

Because edits are anchored find-and-replace, the agent never re-transmits the whole document — just the changed span.

## What ships next

1. Finish the offline PWA replica so any browser tab becomes a full sync node.
2. Land S3 object-storage as a dumb backend for cross-region sync.
3. Ranking pass over full-text search.
