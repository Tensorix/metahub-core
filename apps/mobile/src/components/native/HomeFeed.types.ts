import type { RecentContentItem } from "@/lib/navigation/recent-content";
import type { DocumentActions } from "@/lib/browse/use-document-actions";
import type { ReactElement } from "react";

export interface HomeFeedProps {
  actions: DocumentActions;
  databaseActions: DocumentActions;
  header: ReactElement;
  items: RecentContentItem[];
  openItem(item: RecentContentItem): void;
  empty: ReactElement | null;
}
