import { NativeMenu } from "@/components/native/NativeMenu";
import type { NativeMenuItem } from "@/components/native/NativeMenu.types";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { PropInfo, RecordInfo } from "@/lib/api/sdk";
import { cellText, chipColor, recordTitle, titleProp } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

/** One record as a mobile card: title + up to 3 compact property values.
 *  Select values render as tinted chips like the WebUI. */
export function RecordCard({
  record,
  props,
  onPress,
  onLongPress,
  actions,
}: {
  record: RecordInfo;
  props: PropInfo[];
  onPress: () => void;
  onLongPress?: () => void;
  actions?: NativeMenuItem[];
}) {
  const { tokens, scheme } = useTheme();
  const tp = titleProp(props);

  const detail: { prop: PropInfo; text: string }[] = [];
  for (const p of props) {
    if (detail.length >= 3) break;
    if (p.id === tp?.id) continue;
    const text = cellText(p, record.cells[p.id]);
    if (text) detail.push({ prop: p, text });
  }

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: tokens.surface,
          borderColor: tokens.line,
        },
      ]}
    >
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.open,
          pressed && { backgroundColor: tokens.surface2 },
        ]}
      >
        <Text numberOfLines={1} style={[styles.title, { color: tokens.fg }]}>
          {recordTitle(record, props)}
        </Text>
        {detail.length ? (
          <View style={styles.meta}>
            {detail.map(({ prop, text }) =>
              prop.type === "select" || prop.type === "multi_select" ? (
                text.split(" · ").map((chip) => (
                  <View
                    key={`${prop.id}:${chip}`}
                    style={[
                      styles.chip,
                      { backgroundColor: chipColor(chip, scheme) },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: tokens.fgSoft }]}>
                      {chip}
                    </Text>
                  </View>
                ))
              ) : (
                <Text
                  key={prop.id}
                  numberOfLines={1}
                  style={[styles.metaText, { color: tokens.muted }]}
                >
                  {text}
                </Text>
              ),
            )}
          </View>
        ) : null}
      </Pressable>
      {actions?.length ? (
        <View style={styles.actions}>
          <NativeMenu label="记录操作" items={actions} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginVertical: 4,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  open: { gap: 6, paddingHorizontal: 14, paddingVertical: 11, minHeight: 44 },
  actions: { paddingHorizontal: 14, paddingBottom: 11 },
  title: { fontSize: fs.ui, fontWeight: "500" },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
  },
  metaText: { fontSize: fs.sm },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipText: { fontSize: fs.xs },
});
