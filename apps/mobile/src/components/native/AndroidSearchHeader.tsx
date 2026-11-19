import { useOpenNavigationDrawer } from "./NavigationDrawer.android";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ResultCode, startActivityAsync } from "expo-intent-launcher";
import { Box, Icon, IconButton, Row, Text } from "@expo/ui/jetpack-compose";
import { clickable, fillMaxWidth, height, size, weight } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";
import { NativeHost } from "./NativeHost";

export function AndroidSearchHeader({ placeholder, openSearch }: {
  placeholder: string;
  openSearch: (query?: string) => void;
}) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const openDrawer = useOpenNavigationDrawer();

  async function voiceSearch() {
    try {
      const result = await startActivityAsync("android.speech.action.RECOGNIZE_SPEECH", {
        extra: { "android.speech.extra.LANGUAGE_MODEL": "free_form", "android.speech.extra.PROMPT": placeholder },
      });
      const extras = result.extra as Record<string, unknown> | undefined;
      const matches = extras?.["android.speech.extra.RESULTS"];
      if (result.resultCode === ResultCode.Success && Array.isArray(matches)) {
        const query = matches.find((match) => typeof match === "string" && match.trim());
        if (query) openSearch(query.trim());
      }
    } catch {
      Alert.alert("语音输入暂不可用", "可以使用键盘继续搜索。", [
        { text: "取消", style: "cancel" },
        { text: "键盘输入", onPress: () => openSearch() },
      ]);
    }
  }

  return (
    <View style={{ backgroundColor: tokens.bg, paddingTop: insets.top + 6,
      paddingLeft: insets.left + 16, paddingRight: insets.right + 16, paddingBottom: 8 }}>
      <NativeHost matchContents={{ vertical: true }} style={{ borderRadius: 28, backgroundColor: tokens.surface2 }}>
        <Row verticalAlignment="center" modifiers={[fillMaxWidth(), height(56)]}>
          <IconButton onClick={openDrawer} modifiers={[size(48, 48)]}>
            <Icon source={require("./assets/menu.xml")} size={24} tint={tokens.fg} contentDescription="打开导航侧栏" />
          </IconButton>
          <Box contentAlignment="centerStart" modifiers={[weight(1), height(56), clickable(() => openSearch())]}>
            <Text color={tokens.fgSoft} style={{ typography: "bodyLarge" }}>{placeholder}</Text>
          </Box>
          <IconButton onClick={() => void voiceSearch()} modifiers={[size(48, 48)]}>
            <Icon source={require("./assets/mic.xml")} size={24} tint={tokens.fgSoft} contentDescription="语音搜索" />
          </IconButton>
        </Row>
      </NativeHost>
    </View>
  );
}
