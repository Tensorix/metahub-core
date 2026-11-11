import { Button, Text } from "@expo/ui";
import { NativeHost } from "./native/NativeHost";
import { useTheme } from "@/lib/theme";
import type { ShareActionProps } from "./share-action.types";

/** Android/web fallback. Metro selects share-action.ios.tsx on iOS. */
export function ShareAction({
  label,
  onPress,
  disabled,
  primary = false,
  danger = false,
}: ShareActionProps) {
  const { tokens } = useTheme();
  return (
    <NativeHost matchContents={{ vertical: true }} style={{ minHeight: 52 }}>
      <Button
        variant={primary ? "filled" : danger ? "text" : "outlined"}
        disabled={disabled}
        onPress={onPress}
        style={{ width: "100%", paddingVertical: 12 }}
      >
        <Text
          textStyle={{
            color: disabled
              ? tokens.muted
              : primary
                ? tokens.accentFg
                : danger
                  ? tokens.danger
                  : tokens.accent,
          }}
        >
          {label}
        </Text>
      </Button>
    </NativeHost>
  );
}
