import { useEffect, useState } from "react";
import {
  Dimensions,
  Keyboard,
  useWindowDimensions,
  type KeyboardEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { iosSheetContentHeight } from "./sheet-content-layout";

/** RNHostView's vertical match uses Yoga height even when SwiftUI's sheet is
 * keyboard-constrained. Resize that content before fitToContents sets its detent. */
export function useSheetContentHeight(maxHeight = 600, fraction = 0.7) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(() => Keyboard.metrics());
  useEffect(() => {
    const change = (event: KeyboardEvent) => setKeyboard(event.endCoordinates);
    const hide = () => setKeyboard(undefined);
    const subscriptions = [
      Keyboard.addListener("keyboardWillChangeFrame", change),
      Keyboard.addListener("keyboardDidChangeFrame", change),
      Keyboard.addListener("keyboardWillHide", hide),
      Keyboard.addListener("keyboardDidHide", hide),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  return iosSheetContentHeight({
    windowHeight: height,
    windowWidth: width,
    screenHeight: Dimensions.get("screen").height,
    preferredHeight: Math.min(height * fraction, maxHeight),
    safeTop: insets.top,
    safeBottom: insets.bottom,
    keyboard,
  });
}
