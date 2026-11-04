import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Platform, View } from "react-native";
import { NativeHost } from "./native/NativeHost";
import { RecordTextInput } from "./RecordTextInput";
import { SearchResults } from "./SearchResults";
import { useTheme } from "@/lib/theme";
export default function SearchScreen() {
  const params = useLocalSearchParams<{ q?: string }>();
  const [q, setQ] = useState(params.q ?? "");
  const { tokens } = useTheme();
  if (Platform.OS === "ios")
    return (
      <>
        <SearchResults query={q} />
        <Stack.Title large>搜索</Stack.Title>
        <Stack.SearchBar
          placement="automatic"
          placeholder="搜索文档与记录"
          onChangeText={(e) => setQ(e.nativeEvent.text)}
          onCancelButtonPress={() => setQ("")}
        />
      </>
    );
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Title>搜索</Stack.Title>
      <NativeHost
        matchContents
        style={{ marginHorizontal: 20, marginVertical: 8, minHeight: 56 }}
      >
        <RecordTextInput
          text={q}
          onChangeText={setQ}
          placeholder="搜索文档与记录"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{ padding: 16 }}
        />
      </NativeHost>
      <SearchResults query={q} />
    </View>
  );
}
