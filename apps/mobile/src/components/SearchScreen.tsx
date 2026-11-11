import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import type { SearchBarCommands } from "react-native-screens";
import { Platform, View } from "react-native";
import { NativeHost } from "./native/NativeHost";
import { RecordTextInput } from "./RecordTextInput";
import { SearchResults } from "./SearchResults";
import { useTheme } from "@/lib/theme";
export default function SearchScreen() {
  const params = useLocalSearchParams<{ q?: string }>();
  const initialQuery = params.q ?? "";
  const [input, setInput] = useState({
    source: initialQuery,
    text: initialQuery,
  });
  const q = input.source === initialQuery ? input.text : initialQuery;
  const setQ = (text: string) => setInput({ source: initialQuery, text });
  const { tokens } = useTheme();
  const searchBar = useRef<SearchBarCommands | null>(null);
  // Native search bars are uncontrolled; seed their visible text from deep links.
  useEffect(() => {
    // Stack installs its native header after this screen commits.
    const frame = requestAnimationFrame(() => {
      searchBar.current?.setText(params.q ?? "");
    });
    return () => cancelAnimationFrame(frame);
  }, [params.q]);
  if (Platform.OS === "ios")
    return (
      <>
        <SearchResults query={q} />
        <Stack.Title large>搜索</Stack.Title>
        <Stack.SearchBar
          ref={searchBar}
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
