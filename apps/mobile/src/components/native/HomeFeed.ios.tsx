import { useTheme } from "@/lib/theme";
import {
  Button,
  HStack,
  Image,
  List,
  RNHostView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  contentShape,
  foregroundStyle,
  frame,
  listRowInsets,
  listRowSeparator,
  listStyle,
  scrollContentBackground,
  listRowBackground,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { DocumentRowActions } from "./DocumentRowActions.ios";
import { NativeHost } from "./NativeHost";
import type { HomeFeedProps } from "./HomeFeed.types";

export function HomeFeed({
  actions,
  databaseActions,
  header,
  items,
  openItem,
  empty,
}: HomeFeedProps) {
  const { tokens } = useTheme();
  return (
    <NativeHost style={{ flex: 1 }}>
      <List modifiers={[listStyle("plain"), scrollContentBackground("hidden")]}>
        <VStack
          modifiers={[
            listRowBackground(tokens.bg),
            listRowInsets({ top: 8, bottom: 0, leading: 0, trailing: 0 }),
            listRowSeparator("hidden"),
          ]}
        >
          <RNHostView matchContents={{ vertical: true }}>{header}</RNHostView>
        </VStack>
        {items.map((doc) => (
          <DocumentRowActions
            key={`${doc.kind}:${doc.id}`}
            id={doc.id}
            recent
            actions={doc.kind === "database" ? databaseActions : actions}
            modifiers={[
              listRowBackground(tokens.bg),
              listRowInsets({ top: 4, bottom: 4, leading: 20, trailing: 16 }),
            ]}
          >
            <Button
              onPress={() => openItem(doc)}
              modifiers={[
                buttonStyle("plain"),
                accessibilityLabel(doc.title || "未命名"),
              ]}
            >
              <HStack
                spacing={8}
                modifiers={[
                  frame({ minHeight: 44 }),
                  contentShape(shapes.rectangle()),
                ]}
              >
                <Image
                  systemName={
                    doc.kind === "database" ? "tablecells" : "doc.text"
                  }
                  size={20}
                  modifiers={[
                    frame({ width: 28 }),
                    foregroundStyle({
                      type: "hierarchical",
                      style: "secondary",
                    }),
                  ]}
                />
                <Text>{doc.title || "未命名"}</Text>
                <Spacer minLength={0} />
              </HStack>
            </Button>
          </DocumentRowActions>
        ))}
        {empty && (
          <VStack modifiers={[listRowBackground(tokens.bg)]}>
            <RNHostView matchContents={{ vertical: true }}>{empty}</RNHostView>
          </VStack>
        )}
      </List>
    </NativeHost>
  );
}
