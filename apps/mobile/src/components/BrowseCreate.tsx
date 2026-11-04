import { Button } from "@expo/ui";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Platform } from "react-native";
import { AdaptiveFab } from "./AdaptiveFab";
import { NativeSheet } from "./native/NativeSheet";
import { useTheme } from "@/lib/theme";
export function BrowseCreate() {
  const router = useRouter();
  const { tokens } = useTheme();
  const [open, setOpen] = useState(false);
  const create = (kind: "document" | "database") => {
    setOpen(false);
    router.push(
      kind === "document"
        ? "/manage/document/new?mode=create"
        : "/manage/database/new",
    );
  };
  if (Platform.OS === "ios")
    return (
      <Stack.Toolbar placement="right" tintColor={tokens.accent}>
        <Stack.Toolbar.Menu icon="plus">
          <Stack.Toolbar.Label>新建</Stack.Toolbar.Label>
          <Stack.Toolbar.MenuAction onPress={() => create("document")}>
            新建文档
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction onPress={() => create("database")}>
            新建数据表
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    );
  return (
    <>
      <AdaptiveFab
        label="新建"
        bottomInsetConsumed
        onPress={() => setOpen(true)}
      />
      <NativeSheet isPresented={open} onDismiss={() => setOpen(false)}>
        <Button
          label="新建文档"
          variant="text"
          onPress={() => create("document")}
        />
        <Button
          label="新建数据表"
          variant="text"
          onPress={() => create("database")}
        />
      </NativeSheet>
    </>
  );
}
