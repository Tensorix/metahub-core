import { useCallback, useRef, useState, type ReactNode } from "react";
import { useFocusEffect } from "expo-router";
import { Keyboard, Modal, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Icon, IconButton, Text, TextField, TopAppBar, type TextFieldRef,
} from "@expo/ui/jetpack-compose";
import { fillMaxWidth, semantics, size } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";
import { NativeHost } from "./NativeHost";

export function LibrarySearch({ value, onChangeText, children }: {
  value: string;
  onChangeText: (value: string) => void;
  children?: (close: () => void) => ReactNode;
}) {
  const [searching, setSearching] = useState(false);
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
      <NativeHost matchContents={{ vertical: true }}>
        <TopAppBar
          windowInsets={{ top: insets.top, start: insets.left, end: insets.right }}
          colors={{ containerColor: tokens.bg, titleContentColor: tokens.fg, actionIconContentColor: tokens.fgSoft }}
          modifiers={[fillMaxWidth()]}
        >
          <TopAppBar.Title><Text style={{ typography: "titleLarge" }}>资料库</Text></TopAppBar.Title>
          <TopAppBar.Actions>
            <IconButton modifiers={[size(48, 48)]} onClick={() => setSearching(true)}>
              <Icon source={require("./assets/db-search.xml")} size={24} contentDescription="搜索资料库" />
            </IconButton>
          </TopAppBar.Actions>
        </TopAppBar>
      </NativeHost>
      <Modal visible={searching} animationType="fade" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
        <View style={{ flex: 1, backgroundColor: tokens.bg, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>
          <NativeHost matchContents={{ vertical: true }} style={{ paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: tokens.line, marginBottom: 12 }}>
            {/* SDK 58 SearchBar exposes only submit, not query changes or clear/back slots.
                Use the native M3 text field to retain live local filtering in the search view. */}
            <TextField
              ref={field}
              autoFocus singleLine
              onValueChange={onChangeText}
              keyboardOptions={{ imeAction: "search", autoCorrectEnabled: false }}
              keyboardActions={{ onSearch: () => { void field.current?.blur(); Keyboard.dismiss(); } }}
              colors={{ focusedContainerColor: tokens.bg, unfocusedContainerColor: tokens.bg, focusedIndicatorColor: "transparent", unfocusedIndicatorColor: "transparent" }}
              modifiers={[fillMaxWidth(), semantics({ contentDescription: "搜索资料库" })]}
            >
              <TextField.LeadingIcon>
                <IconButton modifiers={[size(48, 48)]} onClick={close}>
                  <Icon source={require("./assets/back.xml")} size={24} contentDescription="退出搜索" />
                </IconButton>
              </TextField.LeadingIcon>
              <TextField.Placeholder><Text>搜索资料库</Text></TextField.Placeholder>
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
