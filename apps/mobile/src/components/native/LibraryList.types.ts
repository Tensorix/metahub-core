import type { DocumentActions } from "@/lib/browse/use-document-actions";
import type { LibraryKind, Row } from "../../lib/browse/library";
export interface ListProps {
  actions: DocumentActions;
  kind: LibraryKind;
  changeKind(kind: LibraryKind): void;
  rows: Row[];
  open(row: Row): void;
  toggle(row: Row): void;
  more(row: Row): void;
  refresh(): Promise<void>;
  refreshing: boolean;
  error: string;
}
