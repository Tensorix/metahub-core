/** Shared with NativeSheet.ios: fitToContents includes this native padding. */
export const IOS_SHEET_PADDING = {
  top: 16,
  bottom: 24,
  leading: 16,
  trailing: 16,
};
// Leave the sheet's top/grabber below the presenting window's top safe area.
const IOS_SHEET_TOP_CLEARANCE = 24;
export interface SheetKeyboardFrame {
  screenY: number;
  width: number;
  height: number;
}
export function iosSheetContentHeight({
  windowHeight,
  windowWidth,
  screenHeight,
  preferredHeight,
  safeTop,
  safeBottom,
  keyboard,
}: {
  windowHeight: number;
  windowWidth: number;
  screenHeight: number;
  preferredHeight: number;
  safeTop: number;
  safeBottom: number;
  keyboard?: SheetKeyboardFrame;
}) {
  // A floating iPad keyboard doesn't occlude the whole bottom of the window.
  const docked =
    keyboard && keyboard.height > 0 && keyboard.width >= windowWidth;
  const visibleBottom = docked
    ? Math.max(0, Math.min(screenHeight, keyboard.screenY))
    : screenHeight;
  // min also handles a window already resized above the keyboard, without
  // subtracting keyboard height twice. A minimum height must not break the cap.
  const available = Math.max(
    0,
    Math.min(windowHeight, visibleBottom) -
      safeTop -
      safeBottom -
      IOS_SHEET_PADDING.top -
      IOS_SHEET_PADDING.bottom -
      IOS_SHEET_TOP_CLEARANCE,
  );
  return Math.min(preferredHeight, available);
}
