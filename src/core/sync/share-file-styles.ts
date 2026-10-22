// Shared by the server-rendered share and the static encrypted viewer.
// Keep attachments as quiet, full-width rows within the document's reading flow.
export const SHARE_FILE_CSS = `
article.doc p.mh-file{margin:0}
article.doc .mh-file+.mh-file{border-top:1px solid var(--line)}
article.doc .mh-file a{display:block;position:relative;min-height:44px;max-width:100%;padding:11px 36px;border:0;border-radius:4px;background:transparent;color:var(--fg);font-size:14px;line-height:22px;text-decoration:none;overflow-wrap:anywhere}
article.doc .mh-file a::before,article.doc .mh-file a::after{content:"";position:absolute;top:14px;width:16px;height:16px;background:currentColor;opacity:.65;mask:var(--file-icon) center/contain no-repeat}
article.doc .mh-file a::before{left:10px;--file-icon:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z'/%3E%3Cpath d='M14 2v6h6M8 13h8M8 17h5'/%3E%3C/svg%3E")}
article.doc .mh-file a::after{right:10px;--file-icon:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 3v12m-4-4 4 4 4-4M5 16v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4'/%3E%3C/svg%3E")}
article.doc .mh-file a[href]:not([aria-disabled="true"]):hover{background:var(--card);color:var(--accent);text-decoration:underline;text-underline-offset:3px}
article.doc .mh-file a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;background:var(--card);color:var(--accent)}
article.doc .mh-file a[aria-disabled="true"]{color:var(--muted);pointer-events:none}
article.doc .mh-file a[aria-disabled="true"]::after{display:none}
`;
