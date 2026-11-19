import { useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, StyleSheet } from "react-native";
import { BottomSheet, Button, Divider, HStack, Image, Menu, Spacer, Text, TextField, useNativeState, type TextFieldRef } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits, accessibilityHidden, accessibilityLabel, autocorrectionDisabled, buttonStyle, contentShape, font, foregroundStyle, frame,
  glassEffect, menuIndicator, menuOrder, onSubmit, padding, shapes, submitLabel, textInputAutocapitalization, tint,
} from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "@/lib/theme";
import { NativeHost } from "./native/NativeHost";
import type { DatabaseGlassToolbarProps } from "./DatabaseGlassToolbar";

import { DatabaseSettingsSheet, fieldSymbols, PropertyMenuItems, SortMenuItems, type DatabaseSettingsSheetMode } from "./DatabaseToolbarSettings.ios";

const symbols = { filter: "line.3.horizontal.decrease", sort: "arrow.up.arrow.down", properties: "eye", search: "magnifyingglass" } as const;
function TableSearchField({ frame: layout, bottomInset, onAction }: DatabaseGlassToolbarProps) {
  const { tokens } = useTheme();
  const { labels, viewId } = layout;
  const field = useRef<TextFieldRef>(null);
  const text = useNativeState(layout.query);
  const update = (query: string) => onAction({ action: "search", viewId, operation: "change", query });
  return (
    <KeyboardAvoidingView behavior="padding" pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, { bottom: bottomInset, justifyContent: "flex-end" }]}>
      <NativeHost ignoreSafeArea="all" style={{ marginLeft: layout.left, marginBottom: layout.bottom, width: layout.width, height: layout.height }}>
        <HStack spacing={8} modifiers={[
          padding({ leading: 16, trailing: 12 }), frame({ width: layout.width, height: layout.height }),
          glassEffect({ shape: "capsule", glass: { variant: "regular" } }),
        ]}>
          <Image systemName="magnifyingglass" size={18} modifiers={[accessibilityHidden(true)]} />
          <TextField ref={field} text={text} placeholder={labels.tableSearch} autoFocus onTextChange={update}
            modifiers={[accessibilityAddTraits(["isSearchField"]), textInputAutocapitalization("never"), autocorrectionDisabled(),
              submitLabel("search"), onSubmit(Keyboard.dismiss)]} />
          {!!layout.query && <Button modifiers={[buttonStyle("plain"), accessibilityLabel(labels.clear)]} onPress={() => {
            void field.current?.clear(); update(""); void field.current?.focus();
          }}>
            <Image systemName="xmark.circle.fill" size={18} modifiers={[frame({ width: 40, height: layout.height }), contentShape(shapes.rectangle())]} />
          </Button>}
          <Button modifiers={[buttonStyle("plain")]} onPress={() => onAction({ action: "search", viewId, operation: "close" })}>
            <Text modifiers={[foregroundStyle(tokens.accent), frame({ minWidth: 44, minHeight: 44 }), contentShape(shapes.rectangle())]}>{labels.cancel}</Text>
          </Button>
        </HStack>
      </NativeHost>
    </KeyboardAvoidingView>
  );
}

export function DatabaseGlassToolbar({ frame: layout, bottomInset, onAction }: DatabaseGlassToolbarProps) {
  const { tokens } = useTheme();
  const [sheet, setSheet] = useState<DatabaseSettingsSheetMode | null>(null);
  if (layout.searchOpen && !layout.coveredByMenu) {
    return <TableSearchField key={layout.viewId} frame={layout} bottomInset={bottomInset} onAction={onAction} />;
  }
  return (
    <NativeHost ignoreSafeArea="all" pointerEvents={layout.coveredByMenu ? "none" : "auto"} accessibilityElementsHidden={layout.coveredByMenu} style={{
      position: "absolute", left: layout.left, bottom: bottomInset + layout.bottom,
      width: layout.width, height: layout.height,
    }}>
      <BottomSheet isPresented={sheet !== null} onIsPresentedChange={open => { if (!open) setSheet(null); }} anchor={
      <HStack spacing={0} modifiers={[
        padding({ horizontal: 6 }), frame({ width: layout.width, height: layout.height }),
        glassEffect({ shape: "capsule", glass: { variant: "regular", interactive: true } }),
      ]}>
        {layout.actions.map(({ action, width, label, count, active }) => {
          const color = active ? tokens.accent : tokens.fg;
          const symbol = action === "properties" && active ? "eye.slash" : symbols[action];
          const contents = (
            <HStack spacing={5} modifiers={[
              frame({ width, height: layout.height }), contentShape(shapes.rectangle()), foregroundStyle(color),
            ]}>
              <Image systemName={symbol} size={20} />
              {action === "filter" && <Image systemName="chevron.down" size={10} />}
              {action === "filter" && <Text modifiers={[font({ textStyle: "body" })]}>{label}</Text>}
              {!!count && <Text modifiers={[font({ textStyle: "caption2", weight: "semibold" })]}>{count}</Text>}
            </HStack>
          );
          const controlModifiers = [buttonStyle("plain"), tint(color), accessibilityLabel(count ? `${label} ${count}` : label)];
          if (action === "search") return (
            <Button key={action} modifiers={controlModifiers} onPress={() => onAction({ action, viewId: layout.viewId, operation: "open" })}>{contents}</Button>
          );
          if (action === "sort" || action === "properties") return (
            <Menu key={action} label={contents} modifiers={[...controlModifiers, menuIndicator("hidden"), menuOrder("fixed")]}>
              {action === "sort"
                ? <SortMenuItems frame={layout} onAction={onAction} openSheet={setSheet} />
                : <PropertyMenuItems frame={layout} onAction={onAction} openSheet={setSheet} />}
            </Menu>
          );
          return (
            <HStack key={action} spacing={0}>
              <Menu label={contents} modifiers={[...controlModifiers, menuIndicator("hidden"), menuOrder("fixed")]}>
                {layout.properties.length > 6 && <Button label={layout.labels.search} systemImage="magnifyingglass" onPress={() => onAction({ action })} />}
                {layout.properties.length > 6 && <Divider />}
                {layout.properties.map(property => (
                  <Button key={property.id} label={property.name}
                    systemImage={fieldSymbols[property.type as keyof typeof fieldSymbols] ?? "text.alignleft"}
                    onPress={() => onAction({ action, propertyId: property.id })} />
                ))}
              </Menu>
              <Spacer minLength={0} />
            </HStack>
          );
        })}
      </HStack>}>
        {sheet && <DatabaseSettingsSheet key={sheet} mode={sheet} frame={layout} onAction={onAction} close={() => setSheet(null)} />}
      </BottomSheet>
    </NativeHost>
  );
}
