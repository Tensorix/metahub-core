import {
  Button,
  ContentUnavailableView,
  HStack,
  Image,
  ProgressView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  controlSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useWindowDimensions } from "react-native";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { useTheme } from "@/lib/theme";
import { NativeHost } from "./NativeHost";
import type { SearchResultRowProps } from "./SearchPresentation";

// Keep a virtualized RN list, but let SwiftUI lay out and size every visible row.
export function SearchResultRow({ hit, onPress }: SearchResultRowProps) {
  const { tokens } = useTheme();
  const { fontScale } = useWindowDimensions();
  const document = hit.type === "document";
  return (
    <NativeHost matchContents={{ vertical: true }}>
      <Button
        onPress={onPress}
        modifiers={[
          buttonStyle("plain"),
          accessibilityLabel(
            `${hit.title || "未命名"}，${document ? "文档" : "记录"}${hit.snippet ? `，${hit.snippet}` : ""}`,
          ),
        ]}
      >
        <HStack
          alignment="top"
          spacing={14}
          modifiers={[
            padding({ horizontal: 20, vertical: 16 }),
            frame({ maxWidth: Infinity, minHeight: 76, alignment: "leading" }),
            contentShape(shapes.rectangle()),
          ]}
        >
          <Image
            systemName={document ? "doc.text" : "tablecells"}
            modifiers={[
              font({ size: 22 }),
              foregroundStyle(tokens.accent),
              frame({ width: 28 }),
              padding({ top: 2 }),
              accessibilityHidden(),
            ]}
          />
          <VStack
            alignment="leading"
            spacing={6}
            modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
          >
            <Text
              modifiers={[
                font({ textStyle: "headline" }),
                foregroundStyle(tokens.fg),
                ...(fontScale > 1.4 ? [] : [lineLimit(2)]),
              ]}
            >
              {hit.title || "未命名"}
            </Text>
            <Text
              modifiers={[
                font({ textStyle: "caption" }),
                foregroundStyle(tokens.fgSoft),
              ]}
            >
              {document ? "文档" : "记录"}
            </Text>
            {!!hit.snippet && (
              <Text
                modifiers={[
                  font({ textStyle: "subheadline" }),
                  foregroundStyle(tokens.fgSoft),
                  lineLimit(2),
                ]}
              >
                {hit.snippet}
              </Text>
            )}
          </VStack>
          <Image
            systemName="chevron.right"
            modifiers={[
              font({ size: 12, weight: "semibold" }),
              foregroundStyle(tokens.muted),
              padding({ top: 5 }),
              accessibilityHidden(),
            ]}
          />
        </HStack>
      </Button>
    </NativeHost>
  );
}

export function SearchPlaceholder({
  searching = false,
}: {
  searching?: boolean;
}) {
  return (
    <NativeHost
      matchContents={{ vertical: true }}
      style={{ marginTop: 44, marginBottom: 32 }}
    >
      <ContentUnavailableView
        systemImage={searching ? "doc.text.magnifyingglass" : "magnifyingglass"}
        title={searching ? "没有匹配结果" : "搜索你的资料"}
        description={
          searching
            ? "试试更短的关键词"
            : "输入关键词，查找文档正文和数据表记录"
        }
      />
    </NativeHost>
  );
}

export function SearchLoading() {
  return (
    <NativeHost matchContents={{ vertical: true }} style={{ margin: 20 }}>
      <HStack
        spacing={10}
        modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
      >
        <ProgressView />
        <Text
          modifiers={[
            font({ textStyle: "subheadline" }),
            foregroundStyle({ type: "hierarchical", style: "secondary" }),
          ]}
        >
          搜索中…
        </Text>
        <Spacer />
      </HStack>
    </NativeHost>
  );
}

export function SearchRetry({ onPress }: { onPress: () => void }) {
  const { tokens } = useTheme();
  return (
    <NativeHost
      matchContents={{ vertical: true }}
      style={{ marginHorizontal: 20, marginVertical: 24 }}
    >
      <VStack spacing={12}>
        <Text
          modifiers={[
            font({ textStyle: "subheadline" }),
            foregroundStyle(tokens.fgSoft),
          ]}
        >
          更多结果加载失败
        </Text>
        <Button
          label="重试加载"
          onPress={onPress}
          modifiers={[
            buttonStyle(isLiquidGlassAvailable() ? "glass" : "bordered"),
            controlSize("large"),
            tint(tokens.accent),
          ]}
        />
      </VStack>
    </NativeHost>
  );
}
