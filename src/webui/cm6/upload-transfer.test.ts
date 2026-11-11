import { expect, test } from "bun:test";
import { readUploadTransfer } from "./chrome/upload-transfer";

const file = new File([], "empty");
const directoryFile = new File([], "folder");
function transfer(directories: boolean[], files = [directoryFile]): DataTransfer {
  return {
    items: directories.map((isDirectory) => ({
      kind: "file",
      webkitGetAsEntry: () => ({ isDirectory }),
      getAsFile: () => isDirectory ? directoryFile : file,
    })),
    files,
  } as unknown as DataTransfer;
}

test("directories are rejected without falling back to their FileList entries", () => {
  expect(readUploadTransfer(transfer([true, true]))).toEqual({ files: [], hasDirectories: true });
});

test("mixed input keeps ordinary files including empty extensionless files", () => {
  expect(readUploadTransfer(transfer([true, false]))).toEqual({ files: [file], hasDirectories: true });
});

test("files still work when entry inspection is unavailable or returns null", () => {
  for (const webkitGetAsEntry of [undefined, () => null]) {
    const dt = { items: [{ kind: "file", getAsFile: () => file, webkitGetAsEntry }], files: [file] };
    expect(readUploadTransfer(dt as unknown as DataTransfer)).toEqual({ files: [file], hasDirectories: false });
  }
});

test("flat files remain supported when there are no file items", () => {
  expect(readUploadTransfer(transfer([], [file]))).toEqual({ files: [file], hasDirectories: false });
  expect(readUploadTransfer(null)).toEqual({ files: [], hasDirectories: false });
});
