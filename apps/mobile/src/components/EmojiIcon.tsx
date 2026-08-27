import { StyleSheet, Text, View } from "react-native";

/** Emoji glyph in a fixed square, so list rows align like the WebUI sidebar. */
export function EmojiIcon({ emoji, size = 20 }: { emoji: string; size?: number }) {
  return (
    <View style={[styles.box, { width: size + 6, height: size + 6 }]}>
      <Text style={{ fontSize: size - 2, lineHeight: size + 4 }}>{emoji}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
});
