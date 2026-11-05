import { ScrollView } from "react-native";
import { BrowseRow } from "../BrowseRow";
import { useTheme } from "../../lib/theme";
import type { HomeFeedProps } from "./HomeFeed.types";

export function HomeFeed({
  header,
  documents,
  openDocument,
  empty,
}: HomeFeedProps) {
  const { tokens } = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 104 }}
    >
      {header}
      {documents.map((doc) => (
        <BrowseRow
          key={doc.id}
          title={doc.title || "未命名"}
          onPress={() => openDocument(doc.id)}
        />
      ))}
      {empty}
    </ScrollView>
  );
}
