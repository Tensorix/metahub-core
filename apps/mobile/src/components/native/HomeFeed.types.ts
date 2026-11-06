import type { DocumentActions } from "@/lib/browse/use-document-actions";
import type { ReactElement } from "react";

export interface HomeFeedProps {
  actions: DocumentActions;
  header: ReactElement;
  documents: { id: string; title?: string | null }[];
  openDocument(id: string): void;
  empty: ReactElement | null;
}
