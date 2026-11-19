import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { BackHandler, View, useWindowDimensions } from "react-native";
import { Drawer } from "react-native-drawer-layout";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";
import { Column, Icon, Row, Text, useMaterialColors } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, height, padding, selectable, selectableGroup } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";
import { light } from "@/lib/theme/tokens";
import { NativeHost } from "./NativeHost";

const destinations = [
  { title: "首页", path: "/", icon: require("./assets/nav-home.xml") },
  { title: "资料库", path: "/library", icon: require("./assets/settings-folder.xml") },
  { title: "设置", path: "/settings", icon: require("./assets/nav-settings-outline.xml") },
] as const;

const OpenDrawer = createContext<() => void>(() => {});
export const useOpenNavigationDrawer = () => useContext(OpenDrawer);

export function NavigationDrawer({ children }: PropsWithChildren) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const pathname = usePathname();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { scheme, materialYou, dynamicAvailable } = useTheme();
  const colors = useMaterialColors({
    colorScheme: scheme,
    seedColor: materialYou && dynamicAvailable ? undefined : light.accent,
  });

  useEffect(() => {
    if (!open) return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => listener.remove();
  }, [open, close]);

  return (
    <OpenDrawer.Provider value={show}>
      <Drawer open={open} onOpen={show} onClose={close} drawerPosition="left" drawerType="front"
        swipeEnabled={destinations.some(item => item.path === pathname)}
        drawerStyle={{ width: Math.min(360, width - 56), backgroundColor: colors.surfaceContainerLow,
          borderTopRightRadius: 16, borderBottomRightRadius: 16, overflow: "hidden" }}
        overlayStyle={{ backgroundColor: "rgba(0,0,0,0.32)" }} overlayAccessibilityLabel="关闭导航侧栏"
        renderDrawerContent={() => (
          <View style={{ paddingTop: insets.top, paddingHorizontal: 12 }}>
          <NativeHost matchContents={{ vertical: true }}>
            <Column modifiers={[fillMaxWidth(), selectableGroup()]}>
              <Text color={colors.onSurface} style={{ typography: "headlineSmall" }}
                modifiers={[padding(16, 12, 16, 10)]}>MetaHub</Text>
              {destinations.map(item => {
                const selected = pathname === item.path;
                return <Row key={item.path} verticalAlignment="center" horizontalArrangement={{ spacedBy: 12 }}
                  modifiers={[fillMaxWidth(), height(48),
                    selectable(selected, () => {
                      close();
                      if (!selected) router.navigate(item.path);
                    }, "tab"), padding(16, 0, 16, 0)]}>
                  <Icon source={item.icon} size={24} tint={colors.onSurfaceVariant} />
                  <Text color={colors.onSurfaceVariant} style={{ typography: "titleSmall" }}>{item.title}</Text>
                </Row>;
              })}
            </Column>
          </NativeHost>
          </View>
        )}>
        <View style={{ flex: 1 }} importantForAccessibility={open ? "no-hide-descendants" : "auto"}>
          {children}
        </View>
      </Drawer>
    </OpenDrawer.Provider>
  );
}
