/** @jsxImportSource preact */
// Lucide-style line icons. One shared <Icon> keeps SVG out of every component
// and gives consistent stroke/size. `name` indexes PATHS below.

const PATHS: Record<string, string> = {
  cube: '<path d="M21 7.5 12 2 3 7.5v9L12 22l9-5.5z"/><path d="m3 7.5 9 5.5 9-5.5M12 22v-9"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  dots: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  sort: '<path d="M7 3v14M7 17l-3-3M7 17l3-3M17 21V7M17 7l-3 3M17 7l3 3"/>',
  group: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  x: '<path d="M6 6 18 18M18 6 6 18"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v13M8 7l4-4 4 4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  text: '<path d="M4 6h16M4 6v-.5M8 6v13M4 19h8"/><path d="M14 11h6M17 11v8M14 19h6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  numList: '<path d="M10 6h10M10 12h10M10 18h10M4 5h1v4M4 9h2M4 13.5c0-.8 2-.8 2 0 0 .8-2 1.2-2 2.5h2"/>',
  checkbox: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m9 12 2 2 4-4"/>',
  select: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  multi: '<path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01"/>',
  relation: '<path d="M7 7h4v4H7zM13 13h4v4h-4z"/><path d="M11 9h2a2 2 0 0 1 2 2v2"/>',
  quote: '<path d="M7 7c-2 1-3 3-3 6h3v4H4v-4M17 7c-2 1-3 3-3 6h3v4h-3v-4"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>',
  minus: '<path d="M5 12h14"/>',
  heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  cornerUpRight: '<path d="M5 19V11a4 4 0 0 1 4-4h10M15 3l4 4-4 4"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16M9.5 9.5a3 3 0 0 0 4 4M6.5 6.7C4.5 8 3 10 2 12c2 4 6 7 10 7 1.6 0 3-.4 4.4-1.1M9.5 5.2A9.7 9.7 0 0 1 12 5c4 0 8 3 10 7-.6 1.3-1.5 2.5-2.5 3.5"/>',
  bold: '<path d="M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z"/>',
  italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4M4 21h16"/>',
  strike: '<path d="M4 12h16M7 7a4 4 0 0 1 7-1M9 17a4 4 0 0 0 7-2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
};

export function Icon({ name, cls = "ico" }: { name: string; cls?: string }) {
  return (
    <svg class={cls} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: PATHS[name] ?? "" }} />
  );
}

/** Property-type → icon name (kept here so views don't hard-code glyphs). */
export const TYPE_ICON: Record<string, string> = {
  text: "text",
  number: "hash",
  select: "select",
  multi_select: "multi",
  checkbox: "checkbox",
  date: "calendar",
  url: "link",
  relation: "relation",
};
