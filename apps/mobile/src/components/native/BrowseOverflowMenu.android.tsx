import { Fragment } from "react";
import { Box, DropdownMenuGroup, DropdownMenuPopup, DropdownMenuItem, Icon, IconButton, Spacer, Text } from "@expo/ui/jetpack-compose";
import { defaultMinSize, height, size } from "@expo/ui/jetpack-compose/modifiers";
import type { DocumentActions } from "@/lib/browse/use-document-actions";
import { useTheme } from "@/lib/theme";
import { useDocumentMenu } from "./use-document-menu";

const actionIcons = {
  child: require("./assets/add.xml"),
  "copy-id": require("./assets/menu-copy-id.xml"),
  rename: require("./assets/menu-rename.xml"),
  "move-root": require("./assets/menu-move-root.xml"),
  delete: require("./assets/menu-delete.xml"),
  "remove-recent": require("./assets/menu-remove-recent.xml"),
} as const;

export function BrowseOverflowMenu({ id, title, actions, expanded, showMenu, closeMenu, recent }: {
  id: string;
  title: string;
  actions: DocumentActions;
  expanded: boolean;
  showMenu(): void;
  closeMenu(): void;
  recent?: boolean;
}) {
  const { tokens } = useTheme();
  const menu = useDocumentMenu(id, actions);
  const items = menu.items.map(action => ({
    key: action.id,
    label: action.title,
    destructive: !!action.destructive,
    enabled: menu.available,
    onPress: () => actions.perform(id, action.id),
  }));
  const primary = items.filter(item => !item.destructive);
  const groups = [
    [...(recent ? [{ key: "remove-recent" as const, label: "移出最近", enabled: true,
      destructive: false, onPress: () => actions.removeRecent(id) }] : []), ...primary],
    items.filter(item => item.destructive),
  ].filter(group => group.length);

  return (
    <Box>
      <IconButton modifiers={[size(48, 48)]} onClick={showMenu}>
        <Icon source={require("./assets/more-vert.xml")} size={24} contentDescription={`${title}，更多操作`} />
      </IconButton>
      <DropdownMenuPopup expanded={expanded} onDismissRequest={closeMenu}>
        {groups.map((group, index) => (
          <Fragment key={group[0]!.key}>
            {index > 0 && <Spacer modifiers={[height(4)]} />}
            <DropdownMenuGroup shapes={{ index, count: groups.length }}>
              {group.map(item => (
                <DropdownMenuItem key={item.key} enabled={item.enabled}
                  modifiers={[defaultMinSize({ minWidth: 196, minHeight: 48 })]}
                  elementColors={item.destructive ? { textColor: tokens.danger, leadingIconColor: tokens.danger } : undefined}
                  onClick={() => { closeMenu(); item.onPress(); }}>
                  <DropdownMenuItem.LeadingIcon><Icon source={actionIcons[item.key]} size={20} /></DropdownMenuItem.LeadingIcon>
                  <DropdownMenuItem.Text><Text style={{ typography: "bodyLarge" }}>{item.label}</Text></DropdownMenuItem.Text>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuPopup>
    </Box>
  );
}
