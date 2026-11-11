/** Inspect entries synchronously while the paste/drop DataTransfer is readable. */
export function readUploadTransfer(dt: DataTransfer | null | undefined): { files: File[]; hasDirectories: boolean } {
  const files: File[] = [];
  let hasDirectories = false;
  let hasFileItems = false;
  if (!dt) return { files, hasDirectories };
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    hasFileItems = true;
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      hasDirectories = true;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  // Never reintroduce rejected directories through the flat FileList fallback.
  if (!hasFileItems) files.push(...Array.from(dt.files ?? []));
  return { files, hasDirectories };
}
