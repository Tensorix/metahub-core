export const DOCUMENT_TOOLBAR_ACTIONS = [
  { kind: "library", label: "照片与视频", symbol: "photo.on.rectangle" },
  { kind: "file", label: "附件", symbol: "paperclip" },
  { kind: "p", label: "文本", symbol: "paragraphsign" },
  { kind: "h1", label: "标题 1", symbol: "1.square" },
  { kind: "h2", label: "标题 2", symbol: "2.square" },
  { kind: "h3", label: "标题 3", symbol: "3.square" },
  { kind: "bullet", label: "无序列表", symbol: "list.bullet" },
  { kind: "numbered", label: "有序列表", symbol: "list.number" },
  { kind: "todo", label: "待办清单", symbol: "checklist" },
  { kind: "quote", label: "引用", symbol: "text.quote" },
  { kind: "code", label: "代码块", symbol: "curlybraces" },
  { kind: "table", label: "表格", symbol: "tablecells" },
  { kind: "divider", label: "分隔线", symbol: "minus" },
  { kind: "audio", label: "音频", symbol: "waveform" },
  { kind: "html", label: "HTML", symbol: "chevron.left.forwardslash.chevron.right" },
] as const;
export type DocumentToolbarAction = typeof DOCUMENT_TOOLBAR_ACTIONS[number]["kind"];
