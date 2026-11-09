import { Button, Row, Text } from "@expo/ui";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { useTheme } from "@/lib/theme";
import { NativeHost } from "./NativeHost";

type Props = {
  message: string;
  queuedCount: number;
  canUndo: boolean;
  busy: boolean;
  failed: boolean;
  onUndo: () => void;
  onReady: () => void;
};

/** A compact native glass capsule; all content shares one native layout tree. */
export function NativeUndoNotice({
  message,
  queuedCount,
  canUndo,
  busy,
  failed,
  onUndo,
  onReady,
}: Props) {
  const { width, fontScale } = useWindowDimensions();
  const { tokens, scheme } = useTheme();
  const glass = Platform.OS === "ios" && isLiquidGlassAvailable();
  // The action result is enough here; UndoNotice announces the full document title.
  const summary = failed ? message : (message.split("「")[0] ?? message).trim();
  const label = busy ? "恢复中…" : failed ? "重试" : "撤销";
  const textSize = 13 * fontScale;
  const compact = !failed && fontScale <= 1.3;
  return (
    <View style={{ alignSelf: "center" }}>
      <GlassView
        pointerEvents="none"
        glassEffectStyle="regular"
        colorScheme={scheme}
        style={[
          StyleSheet.absoluteFill,
          {
            top: compact ? 4 : 0,
            bottom: compact ? 4 : 0,
            borderRadius: compact ? 18 : 20,
            backgroundColor: glass ? undefined : tokens.surface2,
          },
        ]}
      />
      <NativeHost
        matchContents
        ignoreSafeArea="all"
        onLayoutContent={({ nativeEvent }) => {
          if (nativeEvent.width > 0 && nativeEvent.height > 0) onReady();
        }}
      >
        <Row
          alignment="center"
          spacing={8}
          style={{
            paddingLeft: 14,
            paddingRight: canUndo ? 4 : 14,
            height: canUndo ? undefined : Math.max(44, textSize * 2),
          }}
        >
          <Text
            numberOfLines={failed ? 3 : 1}
            style={failed ? { width: Math.min(width - 150, 220) } : undefined}
            textStyle={{
              color: failed ? tokens.danger : tokens.fg,
              fontSize: textSize,
              fontWeight: "500",
            }}
          >
            {summary}
          </Text>
          {queuedCount > 0 && (
            <Text textStyle={{ color: tokens.fgSoft, fontSize: 11 * fontScale }}>
              {`+${queuedCount}`}
            </Text>
          )}
          {canUndo && <Button
            variant="text"
            style={{ height: Math.max(44, textSize * 2), paddingHorizontal: 10 }}
            disabled={busy}
            onPress={onUndo}
            testID="undo-notice-action"
          >
            <Text textStyle={{
              color: busy ? tokens.fgSoft : tokens.accent,
              fontSize: textSize,
              fontWeight: "600",
            }}>
              {label}
            </Text>
          </Button>}
        </Row>
      </NativeHost>
    </View>
  );
}
