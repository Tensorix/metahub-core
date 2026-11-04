import { SearchBar, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { useRouter } from "expo-router";
import { NativeHost } from "./NativeHost";
export function BrowseSearch() {
  const router = useRouter();
  return (
    <NativeHost
      matchContents={{ vertical: true }}
      style={{ marginHorizontal: 20, marginVertical: 8, minHeight: 56 }}
    >
      <SearchBar
        modifiers={[fillMaxWidth()]}
        onSearch={(q) => {
          if (q.trim()) router.push({ pathname: "/find", params: { q } });
        }}
      >
        <SearchBar.Placeholder>
          <Text>搜索文档与记录</Text>
        </SearchBar.Placeholder>
        <SearchBar.ExpandedFullScreenSearchBar>
          <Text>输入关键词，点按键盘搜索</Text>
        </SearchBar.ExpandedFullScreenSearchBar>
      </SearchBar>
    </NativeHost>
  );
}
