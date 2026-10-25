/** Build-time adapter for CM6 helpers. This module never imports the browser
 * replica or a network transport. Every capability is owned by the native host. */
import { rpc } from "./bridge";
export const NAV_INVALIDATE = "mh-mobile-targets-invalidated";
export const MAX_UPLOAD_BYTES = { image: 20 * 1024 * 1024, video: 200 * 1024 * 1024, audio: 100 * 1024 * 1024, file: 200 * 1024 * 1024 };
export const apiUrl = (_path: string): string => { throw new Error("This formatter is not packaged for mobile"); };
type Target = { id: string; title: string; kind: string };
export const api = {
  listDocuments: async () => (await rpc<Target[]>("targets")).filter(t => t.kind === "doc").map(t => ({ ...t, parent_id: null, database_id: null })),
  listDatabases: async () => (await rpc<Target[]>("targets")).filter(t => t.kind === "db").map(t => ({ ...t, name: t.title })),
  uploadDocBlob: async () => { throw new Error("Use the native attachment button to add media"); },
};
