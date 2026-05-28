# Edit 编辑器选择 设计文档

承接 [01-init-basic-func/design.md](../01-init-basic-func/design.md) §7「人机交互 · 编辑」。本文记录给 `mh edit <id>` 增加**编辑器选择**能力的设计。

## 1. 背景与目标

`mh edit <id>` 原先只从 `process.env.EDITOR || process.env.VISUAL || "vi"` 取编辑器，未设环境变量时静默回退到 `vi`，且无法按次指定编辑器。诉求：

- 提供一个 `--vscode` 便捷开关,直接用 VS Code 打开。
- 提供一个通用机制支持更多编辑器,且不让 flag 列表无限膨胀。

## 2. 设计要点

### 2.1 两个 flag

- `--vscode`:布尔便捷开关 → `code --wait`。
- `--editor <name|command>`:通用入口。值若是**已知编辑器名**则映射到对应调用,否则当作**原始命令**直接透传。

凭 `--editor` 一个参数即可覆盖任意编辑器(`--editor zed`、`--editor "subl -w"`),无需为每个编辑器单开一个 flag。

### 2.2 已知编辑器注册表 + wait flag(关键)

GUI 编辑器(VS Code/Cursor/Zed/Sublime…)默认**立即返回**:`edit` 的流程是「写临时文件 → spawn 编辑器 → `await proc.exited` → 读回文件」,若编辑器没等用户关闭就退出,回读到的还是原文,**改动丢失**。

因此注册表里每个 GUI 编辑器都内置了它的「等待」调用(如 `code --wait`、`subl --wait`),终端编辑器(vim/nano/emacs)天然阻塞、无需额外 flag。这样用户写 `--editor zed` 就自动得到正确的阻塞行为,不必记忆各家的等待参数。

### 2.3 解析优先级

```
--vscode / --editor  >  $EDITOR  >  $VISUAL  >  vi
```

显式 flag 最高;未给 flag 时保持原有 env 回退链,**向后兼容**(`EDITOR=vim mh edit <id>` 行为不变)。

## 3. 取舍

- **不做持久化默认编辑器**:项目当前无设置存储(只有内容库),env 变量已能承担「持久默认」。保持 flag + env 两级,不新增偏好存储(YAGNI)。
- **未知 `--editor` 值直接透传**:作为逃生舱支持任意自定义命令(含其等待参数),代价是拼错的编辑器名不会被校验、会原样 spawn。
- **`--vscode` 与 `--editor` 并存**:`--vscode` 是高频便捷开关,优先级高于 `--editor`;二者同给时以 `--vscode` 为准。
