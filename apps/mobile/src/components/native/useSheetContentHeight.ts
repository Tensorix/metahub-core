import { useWindowDimensions } from "react-native";

/** Compose already constrains its sheet; retain its window-based sizing. */
export function useSheetContentHeight(maxHeight = 600, fraction = 0.7) {
  const { height } = useWindowDimensions();
  return Math.min(height * fraction, maxHeight);
}
