// ---- option colors (stable per string) ----
const HUES = [4, 28, 45, 130, 165, 200, 220, 255, 290, 330];
export function optColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${HUES[h % HUES.length]} 65% 45%)`;
}
