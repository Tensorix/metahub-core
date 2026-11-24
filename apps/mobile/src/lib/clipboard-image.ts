// A base64-encoded PNG must fit in the editor bridge's 24 MiB JSON envelope.
export const MAX_CLIPBOARD_PNG_BYTES = 16 * 1024 * 1024;

export function isClipboardPng(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= Math.ceil(MAX_CLIPBOARD_PNG_BYTES / 3) * 4 &&
    value.length % 4 === 0 && value.startsWith("iVBORw0KGgoAAAANSUhEU");
}
