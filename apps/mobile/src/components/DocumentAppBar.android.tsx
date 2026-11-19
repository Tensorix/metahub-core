import { Fragment, useState } from "react";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Box, DropdownMenuGroup, DropdownMenuItem, DropdownMenuPopup, Icon, IconButton, Spacer, Text, TopAppBar } from "@expo/ui/jetpack-compose";
import { defaultMinSize, fillMaxWidth, height, size } from "@expo/ui/jetpack-compose/modifiers";
import { NativeHost } from "./native/NativeHost";
import { useTheme } from "@/lib/theme";
import type { DocumentAppBarProps, DocumentActionKey } from "./DocumentAppBar";

const icons: Record<DocumentActionKey, number> = {
  mode: require("./native/assets/editor-html.xml"), rename: require("./native/assets/menu-rename.xml"),
  child: require("./native/assets/add.xml"), duplicate: require("./native/assets/menu-copy-id.xml"),
  move: require("./native/assets/settings-folder.xml"), history: require("./native/assets/menu-remove-recent.xml"),
  "copy-id": require("./native/assets/menu-copy-id.xml"), attachments: require("./native/assets/attachment.xml"),
  share: require("./native/assets/share.xml"),
  delete: require("./native/assets/menu-delete.xml"),
};

export function DocumentAppBar({ title, busy, onBack, onShare, items }: DocumentAppBarProps) {
  const [open, setOpen] = useState(false);
  const { tokens, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const groups = [items.filter(item => item.key !== "share" && !item.destructive), items.filter(item => item.destructive)];
  return <>
    <Stack.Screen options={{ title, headerShown: false, statusBarStyle: scheme === "dark" ? "light" : "dark" }} />
    <NativeHost matchContents={{ vertical: true }}>
      <TopAppBar windowInsets={{ top: insets.top, start: insets.left, end: insets.right }}
        modifiers={[fillMaxWidth()]} colors={{ containerColor: tokens.bg, titleContentColor: tokens.fg }}>
        <TopAppBar.NavigationIcon><IconButton enabled={!busy} onClick={onBack} modifiers={[size(48, 48)]}>
          <Icon source={require("./native/assets/back.xml")} size={24} contentDescription="返回" />
        </IconButton></TopAppBar.NavigationIcon>
        <TopAppBar.Title><Text maxLines={1} overflow="ellipsis" style={{ typography: "titleLarge" }}>{title}</Text></TopAppBar.Title>
        <TopAppBar.Actions>
          <IconButton enabled={!busy} onClick={onShare} modifiers={[size(48, 48)]}>
            <Icon source={require("./native/assets/share.xml")} size={24} contentDescription="分享" />
          </IconButton>
          <Box>
            <IconButton onClick={() => setOpen(true)} modifiers={[size(48, 48)]}>
              <Icon source={require("./native/assets/more-vert.xml")} size={24} contentDescription="文档操作" />
            </IconButton>
            <DropdownMenuPopup expanded={open} onDismissRequest={() => setOpen(false)}>
              {groups.map((group, index) => <Fragment key={index}>
                {index > 0 && <Spacer modifiers={[height(4)]} />}
                <DropdownMenuGroup containerColor={tokens.surface2} shapes={{ index, count: groups.length }}>
                  {group.map(item => <DropdownMenuItem key={item.key} enabled={!busy && !item.disabled}
                    modifiers={[defaultMinSize({ minWidth: 196, minHeight: 48 })]}
                    elementColors={item.destructive ? { textColor: tokens.danger, leadingIconColor: tokens.danger } : undefined}
                    onClick={() => { setOpen(false); item.onPress(); }}>
                    <DropdownMenuItem.LeadingIcon><Icon source={icons[item.key]} size={20} /></DropdownMenuItem.LeadingIcon>
                    <DropdownMenuItem.Text><Text style={{ typography: "bodyLarge" }}>{item.label}</Text></DropdownMenuItem.Text>
                  </DropdownMenuItem>)}
                </DropdownMenuGroup>
              </Fragment>)}
            </DropdownMenuPopup>
          </Box>
        </TopAppBar.Actions>
      </TopAppBar>
    </NativeHost>
  </>;
}
