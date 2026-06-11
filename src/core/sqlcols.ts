// Compile-time guard tying a SQL column list to its row interface. There is no
// ORM here on purpose (writes must go through the CRDT oplog, the schema is
// deliberately weak) — this is the one piece of type safety an ORM would have
// bought us: a SELECT list can no longer silently drift from the interface its
// rows are cast to.
//
// Usage, next to the row interface:
//
//   const DOC_COLS = ["id", "title", ...] as const;
//   const _docCols: ColumnsOf<DocumentRow, typeof DOC_COLS> = DOC_COLS;
//   const DOC_SELECT = DOC_COLS.join(", ");
//
// Adding a key to the interface without updating the list makes the `_docCols`
// assignment fail, with the missing column named in the error; a list entry
// that isn't a key of the interface fails element-wise.

export type ColumnsOf<Row, L extends readonly (keyof Row & string)[]> =
  [Exclude<keyof Row, L[number]>] extends [never]
    ? readonly (keyof Row & string)[]
    : ["missing column:", Exclude<keyof Row, L[number]>];
