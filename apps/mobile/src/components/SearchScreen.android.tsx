import { useRef, useState } from "react";
import { Keyboard, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, IconButton, Text, TextField, useNativeState, type TextFieldRef } from "@expo/ui/jetpack-compose";
import { Shapes, clip, fillMaxWidth, semantics, size } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";
import { NativeHost } from "./native/NativeHost";
import { SearchTypeFilter } from "./native/SearchTypeFilter";
import { SearchResults } from "./SearchResults";

const placeholder = "搜索文档与记录";

export default function SearchScreen() {
  const { q = "" } = useLocalSearchParams<{ q?: string }>();
  return <FullScreenSearch key={q} initialQuery={q} />;
}

function FullScreenSearch({ initialQuery }: { initialQuery: string }) {
  const { tokens, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const field = useRef<TextFieldRef>(null);
  const input = useNativeState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<"document" | "record">();
  const clear = () => {
    input.set("");
    setQuery("");
    void field.current?.focus();
  };
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg, paddingTop: insets.top,
      paddingLeft: insets.left, paddingRight: insets.right }}>
      <Stack.Screen options={{ headerShown: false, statusBarStyle: scheme === "dark" ? "light" : "dark" }} />
      <View style={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4,
        borderBottomWidth: 0.5, borderBottomColor: tokens.line }}>
        <NativeHost matchContents={{ vertical: true }}>
          <TextField ref={field} value={input} autoFocus={!initialQuery} singleLine onValueChange={setQuery}
            modifiers={[fillMaxWidth(), clip(Shapes.RoundedCorner(28)), semantics({ contentDescription: placeholder })]}
            colors={{ focusedContainerColor: tokens.surface2, unfocusedContainerColor: tokens.surface2,
              focusedIndicatorColor: "transparent", unfocusedIndicatorColor: "transparent" }}
            keyboardOptions={{ imeAction: "search", autoCorrectEnabled: false }}
            keyboardActions={{ onSearch: () => { void field.current?.blur(); Keyboard.dismiss(); } }}>
            <TextField.LeadingIcon>
              <IconButton modifiers={[size(48, 48)]} onClick={() => router.canGoBack() ? router.back() : router.replace("/")}>
                <Icon source={require("./native/assets/back.xml")} size={24} contentDescription="返回" />
              </IconButton>
            </TextField.LeadingIcon>
            <TextField.Placeholder><Text>{placeholder}</Text></TextField.Placeholder>
            <TextField.TrailingIcon>
              <IconButton enabled={!!query} modifiers={[size(48, 48)]} onClick={clear}>
                <Icon source={require("./native/assets/close.xml")} size={24} contentDescription="清空搜索" />
              </IconButton>
            </TextField.TrailingIcon>
          </TextField>
        </NativeHost>
        <SearchTypeFilter value={kind} onChange={setKind} />
      </View>
      <SearchResults query={query} kind={kind} />
    </View>
  );
}
