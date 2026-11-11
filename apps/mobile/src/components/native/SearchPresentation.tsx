import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { SearchHitInfo } from "@/lib/api/sdk";
import { useTheme } from "@/lib/theme";
import { EmptyState } from "../EmptyState";
import { BrowseIcon } from "../BrowseIcon";
import { NativeButton } from "./NativeButton";

export interface SearchResultRowProps {
  hit: SearchHitInfo;
  onPress: () => void;
}

export function SearchResultRow({ hit, onPress }: SearchResultRowProps) {
  const { tokens } = useTheme();
  const kind = hit.type === "document" ? "文档" : "记录";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${hit.title || "未命名"}，${kind}`}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 16,
        paddingHorizontal: 20,
        flexDirection: "row",
        gap: 14,
        backgroundColor: pressed ? tokens.hover : undefined,
      })}
    >
      <BrowseIcon kind={hit.type === "document" ? "document" : "database"} />
      <View style={{ flex: 1, gap: 6 }}>
        <Text
          numberOfLines={2}
          style={{ fontSize: 17, fontWeight: "600", color: tokens.fg }}
        >
          {hit.title || "未命名"}
        </Text>
        <Text style={{ fontSize: 12, color: tokens.fgSoft }}>{kind}</Text>
        {!!hit.snippet && (
          <Text
            numberOfLines={2}
            style={{ fontSize: 15, lineHeight: 22, color: tokens.fgSoft }}
          >
            {hit.snippet}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export function SearchPlaceholder({
  searching = false,
}: {
  searching?: boolean;
}) {
  return (
    <EmptyState
      title={searching ? "没有匹配结果" : "搜索你的资料"}
      hint={
        searching ? "试试更短的关键词" : "输入关键词，查找文档正文和数据表记录"
      }
    />
  );
}

export function SearchLoading() {
  const { tokens } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        padding: 20,
      }}
    >
      <ActivityIndicator color={tokens.accent} />
      <Text style={{ color: tokens.fgSoft }}>搜索中…</Text>
    </View>
  );
}

export function SearchRetry({ onPress }: { onPress: () => void }) {
  const { tokens } = useTheme();
  return (
    <View style={{ alignItems: "center", padding: 24, gap: 12 }}>
      <Text style={{ color: tokens.fgSoft }}>更多结果加载失败</Text>
      <NativeButton onPress={onPress}>重试加载</NativeButton>
    </View>
  );
}
