export const DOCUMENT_TOOLBAR_ACTIONS = [
  { kind: "bold", label: "粗体", symbol: "bold" },
  { kind: "italic", label: "斜体", symbol: "italic" },
  { kind: "inlineCode", label: "行内代码", symbol: "chevron.left.forwardslash.chevron.right" },
  { kind: "heading", label: "标题：正文 → 一级 → 二级 → 三级", symbol: "textformat.size" },
  { kind: "bullet", label: "无序列表", symbol: "list.bullet" },
  { kind: "numbered", label: "有序列表", symbol: "list.number" },
  { kind: "todo", label: "待办清单", symbol: "checklist" },
  { kind: "quote", label: "引用", symbol: "text.quote" },
  { kind: "library", label: "照片与视频", symbol: "photo.on.rectangle" },
  { kind: "file", label: "附件", symbol: "paperclip" },
  { kind: "table", label: "表格", symbol: "tablecells" },
  { kind: "code", label: "代码块", symbol: "curlybraces" },
  { kind: "divider", label: "分隔线", symbol: "minus" },
  { kind: "audio", label: "音频", symbol: "waveform" },
  { kind: "html", label: "HTML", symbol: "curlybraces.square" },
] as const;
export type DocumentToolbarAction = typeof DOCUMENT_TOOLBAR_ACTIONS[number]["kind"];
