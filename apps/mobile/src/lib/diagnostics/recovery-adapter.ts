/** Native-only adapter checks. Uses private synthetic workspaces and no network. */
import { File, Directory, Paths } from "expo-file-system";
import { openDatabaseSync } from "expo-sqlite";
import { Platform } from "react-native";
import { openMobileReplica } from "../replica/open";
import { nativeSqliteOpenOptions } from "../replica/expo-driver";
import { recoverMobileWorkspace } from "../replica/recovery";
import { createAttachmentStore } from "../attachments/store";
import { hashFile } from "../attachments/native";
import type { Session } from "../auth/session";
import { createDocument, documentVersion, getDocument } from "../../../../../src/core/documents";
import { recoveryItems } from "../../../../../src/core/sync/recovery-v2";
import type { StorageClient, StorageReadResult, S3Config } from "../../../../../src/core/sync/storage";
import { MhError } from "../../../../../src/core/errors";
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
export async function runNativeRecoveryAdapter(): Promise<string[]> {
  const restartMarker = new File(Paths.document, "native-recovery-adapter-restart.json");
  if (restartMarker.exists) {
    const saved = JSON.parse(await restartMarker.text()) as { workspaceId: string; name: string; docId: string; hash: string; };
    const reopened = openMobileReplica(saved.workspaceId, { platform: Platform.OS === "android" ? "android" : "ios" });
    try {
      check(reopened.name === saved.name, "database pointer lost after process restart");
      check(getDocument(reopened.db,saved.docId)?.body?.includes(saved.hash), "document lost after process restart");
      check(recoveryItems(reopened.db).some(item => item.local.includes("unsaved draft preserved")), "recovery draft lost after process restart");
      const pending = createAttachmentStore(reopened.db).pending();
      check(pending.length === 1 && await hashFile(new File(pending[0]!.uri),() => {}) === saved.hash, "pending attachment lost after process restart");
      return ["PASS native process restart retains active database, recovery draft and pending attachment"];
    } finally { reopened.close(); }
  }
  const workspaceId = `recovery-${Date.now()}`;
  const platform = Platform.OS === "android" ? "android" : "ios";
  const source = openMobileReplica(workspaceId,{ platform });
  let replacement: ReturnType<typeof openMobileReplica> | null = null;
  const objects = new Map<string,StorageReadResult>(); let now = Date.now();
  const client: StorageClient = {
    conditionalCreateCapability: async () => true,
    list: async () => { throw new Error("unexpected LIST"); },
    get: async key => objects.get(key)?.bytes ?? null,
    getWithMetadata: async key => { const item = objects.get(key); return item ? { ...item, serverDate: now } : null; },
    put: async (key,bytes,opts) => { if (opts?.ifNoneMatch && objects.has(key)) throw new MhError("conflict","occupied"); objects.set(key,{ bytes: bytes.slice(),serverDate: ++now,lastModified: now,etag: null }); },
    del: async () => { throw new Error("adapter checks never delete bucket objects"); },
  };
  const config: S3Config = { endpoint: "https://synthetic.invalid",region: "test",bucket: "synthetic",prefix: workspaceId,encrypt: false,accessKeyId: "synthetic",secretAccessKey: "synthetic" };
  const directory = new Directory(Paths.document,"recovery-adapter-fixtures",workspaceId);
  directory.create({ intermediates: true,idempotent: true });
  const attachment = new File(directory,"pending.bin"); attachment.write("synthetic unpublished attachment");
  const hash = await hashFile(attachment,() => {});
  const doc = createDocument(source.db,{ title: "adapter fixture",body: `![pending](/blob/${hash})` });
  createAttachmentStore(source.db).put({ src: `/blob/${hash}`,hash,name: "pending.bin",mime: "application/octet-stream",uri: attachment.uri,size: attachment.size,pending: 1,pinned: 1,error: null });
  source.service.drafts.checkpointDocument(doc.id,{ revision: 1,title: "draft",body: "unsaved draft preserved",version: documentVersion(source.db,doc.id) });
  let drained = false;
  const session = { workspaceId,creds: { bucket: config },replica: source,isCurrent: () => true,
    sync: { stop: async () => {} },attachments: { quiesce: async () => { drained = true; } } } as unknown as Session;
  try {
    const result = await recoverMobileWorkspace(session,async () => { replacement = openMobileReplica(workspaceId,{ platform }); },() => {},client);
    check(drained,"attachment quiescence was skipped");
    check(replacement && (replacement as ReturnType<typeof openMobileReplica>).name !== source.name,"active replica pointer did not change");
    check(getDocument(source.db,doc.id)?.body === getDocument(replacement!.db,doc.id)?.body,"current content changed");
    check(recoveryItems(replacement!.db).some(item => item.local.includes("unsaved draft preserved")),"draft missing from recovery");
    const protection = openDatabaseSync(`metahub-protection-${result.packageId}.db`,nativeSqliteOpenOptions);
    try {
      check(protection.getFirstSync<{ quick_check: string }>("PRAGMA quick_check")?.quick_check === "ok","backup integrity failed");
      check(!!protection.getFirstSync("SELECT 1 FROM replica_document_drafts"),"backup lost draft");
    } finally { protection.closeSync(); }
    const protectedFile = new File(Paths.document,"recovery",result.packageId,hash);
    check(protectedFile.exists && await hashFile(protectedFile,() => {}) === hash,"protected attachment invalid");
    check(createAttachmentStore(replacement!.db).pending().length === 1,"pending upload was not retained");
    const selectedName = replacement!.name;
    replacement!.close(); replacement = openMobileReplica(workspaceId,{ platform });
    check(replacement.name === selectedName,"active pointer lost after reopen");
    check(getDocument(replacement.db,doc.id)?.body?.includes(hash),"reopened replica lost document");
    restartMarker.write(JSON.stringify({ workspaceId,name: selectedName,docId: doc.id,hash }));
    return ["PASS native SQLite online backup preserves WAL state and drafts", "PASS native atomic replica pointer survives close/reopen", "PASS native recovery verifies and retains unpublished attachment bytes", "PASS native recovery exposes preserved draft after database swap"];
  } finally { replacement?.close(); source.close(); }
}
