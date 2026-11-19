import { Stack } from "expo-router";

export type DocumentActionKey = "mode" | "rename" | "child" | "duplicate" | "move" | "history" | "copy-id" | "share" | "attachments" | "delete";

export interface DocumentAppBarProps {
  title: string;
  busy: boolean;
  onBack(): void;
  onShare(): void;
  items: { key: DocumentActionKey; label: string; disabled?: boolean; destructive?: boolean; onPress(): void }[];
}

export function DocumentAppBar({ title, busy, onBack, onShare, items }: DocumentAppBarProps) {
  return <>
    <Stack.Screen options={{ title, headerBackButtonMenuEnabled: false }} />
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button accessibilityLabel="返回" icon="chevron.left" disabled={busy} onPress={onBack} />
    </Stack.Toolbar>
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button accessibilityLabel="分享" icon="square.and.arrow.up" disabled={busy} onPress={onShare} />
      <Stack.Toolbar.Menu title="文档操作" accessibilityLabel="文档操作" icon="ellipsis">
        {items.map(item => <Stack.Toolbar.MenuAction key={item.key} disabled={busy || item.disabled}
          destructive={item.destructive} onPress={item.onPress}>{item.label}</Stack.Toolbar.MenuAction>)}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  </>;
}
