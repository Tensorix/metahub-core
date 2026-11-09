import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, Text, View, type PressableProps } from "react-native";
import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import Swipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import {
  GestureHandlerRootView,
  GestureDetector,
  usePanGesture,
} from "react-native-gesture-handler";
import { isFullSwipe } from "@/lib/browse/full-swipe";
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
    else actions.deleteDirect(id);
  };
  const label = recent ? "移出最近" : "删除";
  const [width, setWidth] = useState(0);
  const [armed, setArmed] = useState(false);
  const fullSwipe = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-12, 12],
    failOffsetY: [-16, 16],
    onUpdate: (event) =>
      setArmed(isFullSwipe(event.translationX, event.translationY, width)),
    onDeactivate: (event) => {
      if (
        !event.canceled &&
        isFullSwipe(event.translationX, event.translationY, width)
      )
        swipeAction();
    },
    onFinalize: () => setArmed(false),
  });
  return (
    <GestureDetector gesture={fullSwipe}>
      <View
        collapsable={false}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        <Swipeable
          ref={swipe}
          overshootLeft={false}
          overshootRight
          overshootFriction={1}
          simultaneousWith={fullSwipe}
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
              <Text style={{ color: recent ? tokens.fg : tokens.bg }}>
                {armed ? (recent ? "松开移除" : "松开删除") : label}
              </Text>
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
                    title: actions.kind === "databases" ? "删除数据库" : "删除",
                    attributes: {
                      destructive: true,
                      disabled: !menu.available,
                    },
                  },
                ],
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              const item = menu.items.find(
                (item) => item.id === nativeEvent.event,
              );
              if (item) actions.perform(id, item.id);
            }}
          >
            <View style={{ backgroundColor: tokens.bg }}>
              {/* The render prop only forwards event handlers; refs are read on interaction. */}
              {/* eslint-disable-next-line react-hooks/refs */}
              {children({
                onLongPress: showMenu,
                accessibilityActions: [
                  {
                    name: "show-menu",
                    label:
                      actions.kind === "databases" ? "数据库操作" : "文档操作",
                  },
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
      </View>
    </GestureDetector>
  );
}
