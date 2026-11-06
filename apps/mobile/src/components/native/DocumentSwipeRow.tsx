import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Pressable, Text, View, type PressableProps } from "react-native";
import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import Swipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import type { DocumentActions } from "@/lib/browse/use-document-actions";
import { useTheme } from "@/lib/theme";
import { useDocumentMenu } from "./use-document-menu";

function createCoordinator() {
  let active: SwipeableMethods | null = null;
  return {
    close() {
      active?.close();
      active = null;
    },
    open(row: SwipeableMethods | null) {
      if (active !== row) active?.close();
      active = row;
    },
    forget(row: SwipeableMethods | null) {
      if (active === row) active = null;
    },
  };
}
const Coordinator = createContext<ReturnType<typeof createCoordinator> | null>(
  null,
);
export function DocumentSwipeList({ children }: { children: ReactNode }) {
  const coordinator = useMemo(() => createCoordinator(), []);
  useEffect(() => () => coordinator.close(), [coordinator]);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Coordinator.Provider value={coordinator}>
        {children}
      </Coordinator.Provider>
    </GestureHandlerRootView>
  );
}
export function useCloseDocumentSwipe() {
  return useContext(Coordinator)?.close;
}

export function DocumentSwipeRow({
  id,
  recent,
  actions,
  children,
}: {
  id: string;
  recent?: boolean;
  actions: DocumentActions;
  children: (
    props: Pick<
      PressableProps,
      "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
    >,
  ) => ReactNode;
}) {
  const { scheme, tokens } = useTheme();
  const menu = useDocumentMenu(id, actions);
  const menuRef = useRef<MenuComponentRef>(null);
  const swipe = useRef<SwipeableMethods>(null);
  const coordinator = useContext(Coordinator);
  useEffect(() => {
    const row = swipe.current;
    return () => coordinator?.forget(row);
  }, [coordinator]);
  const showMenu = () => {
    coordinator?.close();
    menu.refresh();
    menuRef.current?.show();
  };
  const swipeAction = () => {
    coordinator?.close();
    if (recent) actions.removeRecent(id);
    else actions.deleteDocument(id);
  };
  const label = recent ? "移出最近" : "删除";
  return (
    <Swipeable
      ref={swipe}
      overshootLeft={false}
      overshootRight={false}
      onSwipeableOpenStartDrag={() => coordinator?.open(swipe.current)}
      onSwipeableWillOpen={() => coordinator?.open(swipe.current)}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={swipeAction}
          style={{
            minWidth: recent ? 112 : 80,
            padding: 16,
            justifyContent: "center",
            backgroundColor: recent ? tokens.surface2 : tokens.danger,
          }}
        >
          <Text style={{ color: recent ? tokens.fg : tokens.bg }}>{label}</Text>
        </Pressable>
      )}
    >
      <MenuView
        ref={menuRef}
        colorScheme={scheme}
        shouldOpenOnLongPress
        onOpenMenu={menu.refresh}
        actions={[
          ...menu.items
            .filter((item) => !item.destructive)
            .map((item) => ({
              id: item.id,
              title: item.title,
              attributes: { disabled: !menu.available },
            })),
          {
            title: "",
            displayInline: true,
            subactions: [
              {
                id: "delete",
                title: "删除",
                attributes: { destructive: true, disabled: !menu.available },
              },
            ],
          },
        ]}
        onPressAction={({ nativeEvent }) => {
          const item = menu.items.find((item) => item.id === nativeEvent.event);
          if (item) actions.perform(id, item.id);
        }}
      >
        <View style={{ backgroundColor: tokens.bg }}>
          {/* The render prop only forwards event handlers; refs are read on interaction. */}
          {/* eslint-disable-next-line react-hooks/refs */}
          {children({
            onLongPress: showMenu,
            accessibilityActions: [
              { name: "show-menu", label: "文档操作" },
              { name: "swipe-action", label },
            ],
            onAccessibilityAction: (event) => {
              if (event.nativeEvent.actionName === "show-menu") showMenu();
              if (event.nativeEvent.actionName === "swipe-action")
                swipeAction();
            },
          })}
        </View>
      </MenuView>
    </Swipeable>
  );
}
