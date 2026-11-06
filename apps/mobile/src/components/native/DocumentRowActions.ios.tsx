import type { ComponentProps, ReactNode } from "react";
import { Button, ContextMenu, Divider, SwipeActions } from "@expo/ui/swift-ui";
import { disabled, onAppear, tint } from "@expo/ui/swift-ui/modifiers";
import type { DocumentActions } from "@/lib/browse/use-document-actions";
import { useTheme } from "@/lib/theme";
import { useDocumentMenu } from "./use-document-menu";

export function DocumentRowActions({
  id,
  recent,
  actions,
  children,
  modifiers,
}: {
  id: string;
  recent?: boolean;
  actions: DocumentActions;
  children: ReactNode;
  modifiers?: ComponentProps<typeof SwipeActions>["modifiers"];
}) {
  const { tokens } = useTheme();
  const menu = useDocumentMenu(id, actions);
  return (
    <SwipeActions modifiers={modifiers}>
      <ContextMenu>
        <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
        <ContextMenu.Items>
          {menu.items.flatMap((item, index) => [
            ...(item.destructive ? [<Divider key="separator" />] : []),
            <Button
              key={item.id}
              label={item.title}
              systemImage={item.symbol}
              role={item.destructive ? "destructive" : "default"}
              modifiers={[
                disabled(!menu.available),
                ...(index === 0 ? [onAppear(menu.refresh)] : []),
              ]}
              onPress={() => actions.perform(id, item.id)}
            />,
          ])}
        </ContextMenu.Items>
      </ContextMenu>
      <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
        <Button
          label={recent ? "移出最近" : "删除"}
          systemImage={recent ? "clock.badge.xmark" : "trash"}
          // Keep the row until confirmation and successful deletion. A destructive
          // SwiftUI swipe button can optimistically remove it before confirmation.
          modifiers={[tint(recent ? tokens.muted : tokens.danger)]}
          onPress={() =>
            recent ? actions.removeRecent(id) : actions.deleteDocument(id)
          }
        />
      </SwipeActions.Actions>
    </SwipeActions>
  );
}
