import { useCallback, useRef, useState, type ReactNode } from "react";
import { AndroidSearchHeader } from "./AndroidSearchHeader";
import { useFocusEffect } from "expo-router";
import { Keyboard, Modal, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Icon, IconButton, Text, TextField, useNativeState, type TextFieldRef,
} from "@expo/ui/jetpack-compose";
import { fillMaxWidth, semantics, size } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";
import { NativeHost } from "./NativeHost";

export function SectionSearch({ placeholder, value, onChangeText, children }: {
  placeholder: string; value: string;
  onChangeText: (value: string) => void;
  children?: (close: () => void) => ReactNode;
}) {
  const [searching, setSearching] = useState(false);
  const input = useNativeState("");
  const field = useRef<TextFieldRef>(null);
  const insets = useSafeAreaInsets();
  const { tokens } = useTheme();
  // Menu actions can navigate as well as result taps; never leave a modal over the destination.
  useFocusEffect(useCallback(() => () => {
    setSearching(false);
    onChangeText("");
  }, [onChangeText]));
  const close = () => {
    Keyboard.dismiss();
    setSearching(false);
    onChangeText("");
  };
  return (
    <>
      <AndroidSearchHeader placeholder={placeholder} openSearch={(query = "") => {
        input.set(query);
        onChangeText(query);
        setSearching(true);
      }} />
      <Modal visible={searching} animationType="fade" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
        <View style={{ flex: 1, backgroundColor: tokens.bg, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>
          <NativeHost matchContents={{ vertical: true }} style={{ paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: tokens.line, marginBottom: 12 }}>
            {/* SDK 58 SearchBar exposes only submit, not query changes or clear/back slots.
                Use the native M3 text field to retain live local filtering in the search view. */}
            <TextField
              ref={field}
              value={input}
              autoFocus singleLine
              onValueChange={onChangeText}
              keyboardOptions={{ imeAction: "search", autoCorrectEnabled: false }}
              keyboardActions={{ onSearch: () => { void field.current?.blur(); Keyboard.dismiss(); } }}
              colors={{ focusedContainerColor: tokens.bg, unfocusedContainerColor: tokens.bg, focusedIndicatorColor: "transparent", unfocusedIndicatorColor: "transparent" }}
              modifiers={[fillMaxWidth(), semantics({ contentDescription: placeholder })]}
            >
              <TextField.LeadingIcon>
                <IconButton modifiers={[size(48, 48)]} onClick={close}>
                  <Icon source={require("./assets/back.xml")} size={24} contentDescription="退出搜索" />
                </IconButton>
              </TextField.LeadingIcon>
              <TextField.Placeholder><Text>{placeholder}</Text></TextField.Placeholder>
              {!!value && <TextField.TrailingIcon>
                <IconButton modifiers={[size(48, 48)]} onClick={() => { void field.current?.clear(); onChangeText(""); void field.current?.focus(); }}>
                  <Icon source={require("./assets/close.xml")} size={24} contentDescription="清空搜索" />
                </IconButton>
              </TextField.TrailingIcon>}
            </TextField>
          </NativeHost>
          {children?.(close)}
        </View>
      </Modal>
    </>
  );
}
