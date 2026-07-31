import { describe, expect, test } from "bun:test";
import {
  buildDocTimeline,
  diffLines,
  foldSame,
  groupLabel,
  richDiffSections,
  type DiffLine,
} from "./hist-diff.ts";
import { renderMarkdown } from "../core/sync/share-render.ts";
import type { DocRevision } from "../core/history.ts";

describe("diffLines", () => {
  test("del comes from base, add from target, with true line numbers", () => {
    const rows = diffLines("one\ntwo", "one\nthree");
    expect(rows[0]).toEqual({ kind: "same", text: "one", oldNo: 1, newNo: 1 });
    expect(rows[1]).toMatchObject({ kind: "del", text: "two", oldNo: 2 });
    expect(rows[2]).toMatchObject({ kind: "add", text: "three", newNo: 2 });
  });

  test("blank lines are kept so numbering stays true to the source", () => {
    const rows = diffLines("a\n\nb", "a\n\nb\n\nc");
    expect(rows.map((r) => r.kind)).toEqual(["same", "same", "same", "add", "add"]);
    expect(rows[2]).toMatchObject({ text: "b", oldNo: 3, newNo: 3 });
    expect(rows[4]).toMatchObject({ kind: "add", text: "c", newNo: 5 });
  });

  test("empty base marks everything as added", () => {
    const rows = diffLines("", "x\ny");
    expect(rows).toEqual([
      { kind: "add", text: "x", newNo: 1 },
      { kind: "add", text: "y", newNo: 2 },
    ]);
  });

  test("fenced-code lines carry mono, prose lines don't", () => {
    const base = "段落\n```ts\nconst a = 1;\n```";
    const target = "段落改\n```ts\nconst a = 2;\n```";
    const rows = diffLines(base, target);
    const prose = rows.filter((r) => r.text.startsWith("段落"));
    expect(prose.every((r) => !r.mono)).toBe(true);
    for (const t of ["```ts", "const a = 1;", "const a = 2;", "```"])
      expect(rows.find((r) => r.text === t)!.mono).toBe(true);
  });

  test("intra-line segments mark the changed middle", () => {
    const rows = diffLines("hello old world", "hello new world");
    const del = rows.find((r) => r.kind === "del")!;
    const add = rows.find((r) => r.kind === "add")!;
    expect(del.seg).toEqual(["hello ", "old", " world"]);
    expect(add.seg).toEqual(["hello ", "new", " world"]);
  });
});

describe("foldSame", () => {
  const same = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      kind: "same" as const,
      text: `l${i}`,
      oldNo: i + 1,
      newNo: i + 1,
    }));

  test("long unchanged middle folds, keeping context around the change", () => {
    const rows = diffLines(
      ["x", ...Array.from({ length: 12 }, (_, i) => `k${i}`), "y"].join("\n"),
      ["X", ...Array.from({ length: 12 }, (_, i) => `k${i}`), "Y"].join("\n"),
    );
    const secs = foldSame(rows, 2, 3);
    expect(secs.map((s) => s.kind)).toEqual(["rows", "fold", "rows"]);
    // del x / add X + 2 context lines before the fold…
    expect(secs[0]!.rows.map((r) => r.text)).toEqual(["x", "X", "k0", "k1"]);
    // …8 hidden…
    expect(secs[1]!.rows).toHaveLength(8);
    // …2 context lines + del y / add Y after.
    expect(secs[2]!.rows.map((r) => r.text)).toEqual(["k10", "k11", "y", "Y"]);
  });

  test("short unchanged runs stay visible", () => {
    const rows: DiffLine[] = [...same(4)];
    rows.push({ kind: "add", text: "n", newNo: 5 });
    expect(foldSame(rows, 3, 5).map((s) => s.kind)).toEqual(["rows"]);
  });

  test("edge runs fold without inner-side context waste", () => {
    const rows: DiffLine[] = [...same(10)];
    rows.push({ kind: "add", text: "n", newNo: 11 });
    const secs = foldSame(rows, 2, 5);
    expect(secs.map((s) => s.kind)).toEqual(["fold", "rows"]);
    expect(secs[0]!.rows).toHaveLength(8); // leading edge keeps no head context
    expect(secs[1]!.rows.map((r) => r.text)).toEqual(["l8", "l9", "n"]);
  });
});

// ---- rich diff ---------------------------------------------------------------

describe("richDiffSections", () => {
  const render = (md: string) => renderMarkdown(md);
  const html = (base: string, target: string) =>
    richDiffSections(base, target, render)
      .map((s) => s.html)
      .join("");

  test("edited paragraph merges word-level del/ins marks into one render", () => {
    const out = html("上下文\n\n这是一段话", "上下文\n\n这是两段话");
    expect(out).toContain('<div class="rd same"><p>上下文</p></div>');
    expect(out).toContain('<del class="rdx">一</del>');
    expect(out).toContain('<ins class="rdi">两</ins>');
    expect(out).toContain('class="rd edit"');
    expect(out).not.toContain("\uE000");
  });

  test("marks survive inside inline formatting", () => {
    const out = html("**加粗的旧词**", "**加粗的新词**");
    expect(out).toContain("<strong>");
    expect(out).toContain('<del class="rdx">旧</del>');
    expect(out).toContain('<ins class="rdi">新</ins>');
  });

  test("block type change falls back to stacked old/new blocks", () => {
    const out = html("## 标题", "# 标题");
    expect(out).toContain('class="rd del"');
    expect(out).toContain('class="rd add"');
    expect(out).not.toContain('class="rd edit"');
  });

  test("a change inside a link URL falls back instead of breaking the tag", () => {
    const out = html("[站点](https://old.example.com)", "[站点](https://new.example.com)");
    expect(out).not.toContain("\uE000");
    expect(out).toContain('class="rd del"');
    expect(out).toContain('class="rd add"');
  });

  test("added / removed whole blocks get washes; long same runs fold", () => {
    const filler = Array.from({ length: 6 }, (_, i) => `p${i}`).join("\n\n");
    const secs = richDiffSections(`新增前\n\n${filler}`, `改动了\n\n${filler}`, render);
    expect(secs[0]!.kind).toBe("rows");
    expect(secs[0]!.html).toContain('class="rd edit"');
    expect(secs.some((s) => s.kind === "fold")).toBe(true);
    const addOnly = html("a", "a\n\nb");
    expect(addOnly).toContain('<div class="rd add"><p>b</p></div>');
  });

  test("appending items to a long list marks only the new items", () => {
    const oldList = "硬边界\n\n1. 只接派单。\n2. 先澄清。\n3. 先自检。\n4. 密钥零回显。";
    const newList = oldList + "\n5. 沙盒命令一次一条。\n6. 长任务定期小结。";
    const out = html(oldList, newList);
    expect(out).toContain('class="rd edit"');
    expect(out).not.toContain('class="rd del"'); // the old items must NOT read as deleted-and-rewritten
    expect(out).not.toContain("<del");
    expect(out).toContain('<ins class="rdi">沙盒命令一次一条。</ins>');
    expect(out).toContain('<ins class="rdi">长任务定期小结。</ins>');
  });

  test("inserting mid-list doesn't flag the renumbered neighbours", () => {
    const out = html("1. 甲\n2. 乙\n3. 丙", "1. 甲\n2. 新\n3. 乙\n4. 丙");
    expect(out).toContain('class="rd edit"');
    expect(out).toContain('<ins class="rdi">新</ins>');
    expect(out).not.toContain("<del"); // 乙/丙 only changed number — silent
  });

  test("editing one line of a multi-line block marks just that line", () => {
    const out = html("第一行\n第二行旧\n第三行", "第一行\n第二行新\n第三行");
    expect(out).toContain('class="rd edit"');
    expect(out).toContain('<del class="rdx">旧</del>');
    expect(out).toContain('<ins class="rdi">新</ins>');
    expect((out.match(/<ins/g) ?? []).length).toBe(1);
  });

  test("table block edits fall back to stacked", () => {
    const out = html("| a | b |\n| - | - |\n| 1 | 2 |", "| a | b |\n| - | - |\n| 1 | 3 |");
    expect(out).toContain('class="rd del"');
    expect(out).toContain('class="rd add"');
    expect(out).not.toContain('class="rd edit"');
  });

  test("code fence edits keep the fence rendered as code", () => {
    const out = html("```ts\nconst a = 1;\n```", "```ts\nconst a = 2;\n```");
    expect(out).toContain("<pre>");
    expect(out).toContain('<del class="rdx">1;</del>');
    expect(out).toContain('<ins class="rdi">2;</ins>');
  });
});

// ---- timeline ----------------------------------------------------------------

const NOW = new Date(2026, 6, 31); // local 2026-07-31 (a Friday)

/** Local-time ISO stamp — grouping is by local calendar day, so tests must not
 *  bake in a UTC offset. */
const at = (d: number, h: number, min: number, mo = 7, y = 2026): string =>
  new Date(y, mo - 1, d, h, min).toISOString();

let seq = 0;
function rev(atIso: string, over: Partial<DocRevision> = {}): DocRevision {
  return {
    version: over.version ?? `v${seq++}`,
    at: atIso,
    node_id: "nodeA",
    kind: "user",
    changes: 1,
    created: false,
    deleted: false,
    title_changed: false,
    blocks_changed: 1,
    blocks_deleted: 0,
    ...over,
  };
}

describe("groupLabel", () => {
  test("buckets by recency", () => {
    expect(groupLabel(at(31, 9, 0), NOW)).toBe("今天");
    expect(groupLabel(at(30, 9, 0), NOW)).toBe("昨天");
    expect(groupLabel(at(27, 9, 0), NOW)).toBe("本周"); // Monday
    expect(groupLabel(at(10, 9, 0), NOW)).toBe("7月10日");
    expect(groupLabel(at(5, 9, 0, 3), NOW)).toBe("2026年3月");
    expect(groupLabel(at(5, 9, 0, 12, 2025), NOW)).toBe("2025年12月");
  });
});

describe("buildDocTimeline", () => {
  test("a run of 4+ minor edits folds into a cluster; head never folds", () => {
    const revs = [
      rev(at(31, 10, 5)), // head — must stay visible
      rev(at(31, 10, 4)),
      rev(at(31, 10, 3)),
      rev(at(31, 10, 2)),
      rev(at(31, 10, 1)),
    ];
    const groups = buildDocTimeline(revs, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("今天");
    expect(groups[0]!.entries).toHaveLength(2);
    expect(groups[0]!.entries[0]!.type).toBe("rev");
    const c = groups[0]!.entries[1]!;
    expect(c.type).toBe("cluster");
    if (c.type === "cluster") expect(c.revs).toHaveLength(4);
  });

  test("runs of 3 or fewer stay individual", () => {
    const revs = [
      rev(at(31, 10, 5), { title_changed: true }),
      rev(at(31, 10, 4)),
      rev(at(31, 10, 3)),
      rev(at(31, 10, 2)),
    ];
    const groups = buildDocTimeline(revs, NOW);
    expect(groups[0]!.entries.every((e) => e.type === "rev")).toBe(true);
  });

  test("device change and >10min gaps break a run", () => {
    const revs = [
      rev(at(31, 12, 0), { created: true }),
      rev(at(31, 10, 5)),
      rev(at(31, 10, 4)),
      rev(at(31, 10, 3), { node_id: "nodeB" }),
      rev(at(31, 10, 2)),
      rev(at(31, 9, 0)), // 62 min before the previous one
    ];
    const groups = buildDocTimeline(revs, NOW);
    expect(groups[0]!.entries.every((e) => e.type === "rev")).toBe(true);
  });

  test("major revisions (created/deleted/title/big) never fold", () => {
    const revs = [
      rev(at(31, 10, 5)),
      rev(at(31, 10, 4), { blocks_changed: 9 }),
      rev(at(31, 10, 3), { deleted: true }),
      rev(at(31, 10, 2), { kind: "repair" }),
      rev(at(31, 10, 1)),
    ];
    const groups = buildDocTimeline(revs, NOW);
    expect(groups[0]!.entries.every((e) => e.type === "rev")).toBe(true);
  });

  test("clusters never span date groups", () => {
    const revs = [
      rev(at(31, 10, 0), { created: true }),
      rev(at(31, 0, 4)),
      rev(at(31, 0, 3)),
      // local date boundary sits inside this 10-min-dense run
      rev(at(30, 23, 59)),
      rev(at(30, 23, 58)),
    ];
    const groups = buildDocTimeline(revs, NOW);
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天"]);
    for (const g of groups) expect(g.entries.every((e) => e.type === "rev")).toBe(true);
  });
});
