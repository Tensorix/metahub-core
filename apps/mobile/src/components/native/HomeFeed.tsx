import { ScrollView } from "react-native";
import { BrowseRow } from "../BrowseRow";
import { useTheme } from "../../lib/theme";
import type { HomeFeedProps } from "./HomeFeed.types";
import {
  DocumentSwipeList,
  DocumentSwipeRow,
  useCloseDocumentSwipe,
} from "./DocumentSwipeRow";

export function HomeFeed(props: HomeFeedProps) {
  return (
    <DocumentSwipeList>
      <Feed {...props} />
    </DocumentSwipeList>
  );
}
function Feed({
  actions,
  header,
  documents,
  openDocument,
  empty,
}: HomeFeedProps) {
  const { tokens } = useTheme();
  const closeSwipe = useCloseDocumentSwipe();
  return (
    <ScrollView
      onScrollBeginDrag={closeSwipe}
      style={{ flex: 1, backgroundColor: tokens.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 104 }}
    >
      {header}
      {documents.map((doc) => (
        <DocumentSwipeRow key={doc.id} id={doc.id} recent actions={actions}>
          {(pressableProps) => (
            <BrowseRow
              {...pressableProps}
              title={doc.title || "未命名"}
              onPress={() => openDocument(doc.id)}
            />
          )}
        </DocumentSwipeRow>
      ))}
      {empty}
    </ScrollView>
  );
}
