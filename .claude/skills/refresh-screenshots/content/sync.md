Sync is a stateless **push/pull** exchange of oplog operations. A server is not special — it is a metahub node that happens to listen on a port.

## One round

```bash
# machine A: start the sync server (itself a node)
mh --server --port 7777

# machine B: push local ops, pull remote ops, merge
mh sync http://a-host:7777
```

Each side sends the operations the other has not seen, keyed by a per-node vector clock. Merges are commutative, so the order rounds arrive in does not matter.

## Conflict handling

- **Records** — last-writer-wins per *cell*, so two people editing different columns never conflict.
- **Documents** — block-level CRDT; concurrent edits to different paragraphs both survive.
- **Schema** — property definitions carry their own history and can be rolled back independently.

## Credentials

| Path | Auth | Notes |
| --- | --- | --- |
| `/sync` | master token *or* pairing credential | each paired device gets a revocable credential |
| `/api/*` | Bearer token | same token guards REST |
| `/sites/<name>/` | same-origin | hosted pages hold full hub access |

Pair two devices once and a built-in timer syncs them both ways — no need to run `mh sync` by hand.
