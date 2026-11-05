import type { ReactElement } from "react";

export interface HomeFeedProps {
  header: ReactElement;
  documents: { id: string; title?: string | null }[];
  openDocument(id: string): void;
  empty: ReactElement | null;
}
