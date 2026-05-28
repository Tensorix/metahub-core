# Edit 编辑器选择 实现文档

配套设计见 [design.md](./design.md)。本文是代码级实现说明。承接 [01-init-basic-func/implementation.md](../01-init-basic-func/implementation.md) §6 CLI。

## 1. 改动文件

| 文件 | 改动 |
|------|------|
| `src/cli/editor.ts` | 新增 `KNOWN_EDITORS` 注册表、`EditOptions` 接口、纯函数 `resolveEditorCommand`;`editInEditor` / `runEdit` 改为接收解析后的命令 |
| `src/cli/commands/edit.ts` | 新增 `--vscode` / `--editor` 两个 args,透传给 `runEdit` |
| `src/cli/editor.test.ts` | 新增:`resolveEditorCommand` 单测 |

## 2. 编辑器解析(`src/cli/editor.ts`)

```ts
const KNOWN_EDITORS: Record<string, string> = {
  vscode: "code --wait", code: "code --wait", cursor: "cursor --wait",
  windsurf: "windsurf --wait", zed: "zed --wait",
  sublime: "subl --wait", subl: "subl --wait", atom: "atom --wait",
  idea: "idea --wait", webstorm: "webstorm --wait",
  vim: "vim", nvim: "nvim", neovim: "nvim", vi: "vi",
  nano: "nano", emacs: "emacs", emacsclient: "emacsclient",
};

export interface EditOptions { editor?: string; vscode?: boolean }

export function resolveEditorCommand(opts = {}, env = process.env): string {
  if (opts.vscode) return KNOWN_EDITORS.vscode!;          // 1. --vscode
  if (opts.editor) {                                       // 2. --editor
    const key = opts.editor.trim().toLowerCase();
    return KNOWN_EDITORS[key] ?? opts.editor;             //    已知名→映射,否则原样透传
  }
  return env.EDITOR || env.VISUAL || "vi";                // 3. env 回退链
}
```

| 函数 | 作用 |
|------|------|
| `resolveEditorCommand(opts, env?) -> string` | **纯函数**:按 `--vscode > --editor > $EDITOR > $VISUAL > vi` 解析出最终命令串;`env` 可注入以便测试 |
| `editInEditor(initial, ext, editorCmd)` | 用解析好的 `editorCmd` spawn(原 env 读取下放到 `resolveEditorCommand`);仍 `editorCmd.split(" ")` 拆出参数,`"code --wait"` → `["code","--wait",file]` |
| `runEdit(db, id, opts?)` | 先 `resolveEditorCommand(opts)` 取一次命令,再分别传给文档(md)/记录(表单)两条 `editInEditor` |

解析逻辑独立成纯函数的好处:`editInEditor` 的 spawn 路径难以单测(需真实拉起编辑器),而解析这块全部可测,无需 mock `Bun.spawn`。

## 3. 命令接线(`src/cli/commands/edit.ts`)

```ts
args: {
  id:     { type: "positional", required: true, description: "Document or record id" },
  vscode: { type: "boolean", description: "Open in VS Code (code --wait)" },
  editor: { type: "string",  description: "Editor: known name (vscode, cursor, zed, sublime, vim, nvim, nano, emacs) or a raw command" },
},
run: guard(async (args) => {
  const r = await runEdit(openMetahub(), args.id, { editor: args.editor, vscode: args.vscode });
  print(r, () => `${r.changed ? "edited" : "unchanged"} ${r.type} ${r.id}`);
}),
```

输出仍走 `print` / `guard`,未改。

## 4. 用法

```sh
mh edit <id> --vscode             # code --wait
mh edit <id> --editor zed         # zed --wait
mh edit <id> --editor cursor      # cursor --wait
mh edit <id> --editor "subl -w"   # 原始命令透传
EDITOR=vim mh edit <id>           # 未给 flag,仍走 env 回退
```

## 5. 测试与验证

- `bun test src/cli/editor.test.ts`:覆盖 `--vscode`、`--editor` 已知名映射(大小写/空白归一化)、未知值透传、env 回退链(`EDITOR`/`VISUAL`/`vi`)、flag 优先于 env。
- `bunx tsc -p tsconfig.build.json --noEmit`:类型检查通过。
- `mh edit --help`:列出 `--vscode` / `--editor`。
- GUI 阻塞手验:`mh edit <id> --vscode`,在关闭标签页前所做改动应被持久化(证明 `--wait` 生效)。

## 6. 命令清单更新

01 实现文档 §6 命令清单中 `mh edit <id>` 一行更新为:

| 命令 | 关键参数 |
|------|----------|
| `mh edit <id> [--vscode] [--editor <name\|command>]` | 文档/记录开编辑器;选择编辑器,默认回退 `$EDITOR`/`$VISUAL`/`vi` |
