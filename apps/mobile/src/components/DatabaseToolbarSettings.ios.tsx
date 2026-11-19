import { useState } from "react";
import { Button, Divider, Group, HStack, Label, List, Menu, Spacer, Text, TextField, Toggle, VStack } from "@expo/ui/swift-ui";
import { disabled, environment, font, menuOrder, padding, presentationDetents, presentationDragIndicator } from "@expo/ui/swift-ui/modifiers";
import type { DatabaseGlassToolbarProps } from "./DatabaseGlassToolbar";

export const fieldSymbols = {
  text: "text.alignleft", number: "number", select: "circle.inset.filled",
  multi_select: "checklist", checkbox: "checkmark.square", date: "calendar",
  url: "link", relation: "arrow.triangle.branch", doc: "doc.text",
} as const;
type SheetMode = "sortOrder" | "propertyOrder" | "searchSort";
export type DatabaseSettingsSheetMode = SheetMode;
type SettingsProps = Pick<DatabaseGlassToolbarProps, "frame" | "onAction">;
type MenuProps = SettingsProps & { openSheet(mode: SheetMode): void };
const iconFor = (type: string) => fieldSymbols[type as keyof typeof fieldSymbols] ?? "text.alignleft";

export function SortMenuItems({ frame, onAction, openSheet }: MenuProps) {
  const { labels, sort, viewId } = frame;
  const available = frame.properties.filter(p => !sort.some(rule => rule.prop === p.id));
  const fields = available.map(p => <Button key={p.id} label={p.name} systemImage={iconFor(p.type)}
    onPress={() => onAction({ action: "sort", viewId, operation: "set", propertyId: p.id, desc: false })} />);
  const add = <>
    {available.length > 6 && <Button label={labels.search} systemImage="magnifyingglass" onPress={() => openSheet("searchSort")} />}
    {fields}
  </>;
  if (!sort.length) return add;
  return <>
    {sort.map(({ prop, desc }) => {
      const name = frame.properties.find(p => p.id === prop)?.name;
      if (!name) return null;
      return <Menu key={prop} label={name} systemImage={desc ? "arrow.down" : "arrow.up"} modifiers={[menuOrder("fixed")]}>
        <Button label={labels.asc} systemImage={!desc ? "checkmark" : "arrow.up"}
          onPress={() => onAction({ action: "sort", viewId, operation: "set", propertyId: prop, desc: false })} />
        <Button label={labels.desc} systemImage={desc ? "checkmark" : "arrow.down"}
          onPress={() => onAction({ action: "sort", viewId, operation: "set", propertyId: prop, desc: true })} />
        <Button label={labels.removeSort} systemImage="minus.circle"
          onPress={() => onAction({ action: "sort", viewId, operation: "remove", propertyId: prop })} />
      </Menu>;
    })}
    <Divider />
    {available.length > 0 && <Menu label={labels.addSort} systemImage="plus" modifiers={[menuOrder("fixed")]}>{add}</Menu>}
    {sort.length > 1 && <Button label={labels.reorder} systemImage="arrow.up.arrow.down" onPress={() => openSheet("sortOrder")} />}
    <Button label={labels.clearSort} systemImage="xmark" onPress={() => onAction({ action: "sort", viewId, operation: "clear" })} />
  </>;
}

export function PropertyMenuItems({ frame, onAction, openSheet }: MenuProps) {
  const { labels, viewId } = frame;
  return <>
    {frame.properties.map((p, i) => (
      <Toggle key={p.id} label={p.name} systemImage={iconFor(p.type)} isOn={i === 0 || !frame.hidden.includes(p.id)}
        modifiers={[disabled(i === 0)]}
        onIsOnChange={visible => onAction({ action: "properties", viewId, operation: "visible", propertyId: p.id, visible })} />
    ))}
    <Divider />
    <Button label={labels.showAll} systemImage="eye" onPress={() => onAction({ action: "properties", viewId, operation: "all", visible: true })} />
    <Button label={labels.hideAll} systemImage="eye.slash" onPress={() => onAction({ action: "properties", viewId, operation: "all", visible: false })} />
    {frame.properties.length > 1 && <Button label={labels.reorder} systemImage="arrow.up.arrow.down" onPress={() => openSheet("propertyOrder")} />}
  </>;
}

export function DatabaseSettingsSheet({ mode, frame, onAction, close }: SettingsProps & { mode: SheetMode; close(): void }) {
  const [query, setQuery] = useState("");
  const { labels, properties, viewId } = frame;
  const searching = mode === "searchSort";
  const items = mode === "propertyOrder" ? properties : searching
    ? properties.filter(p => !frame.sort.some(s => s.prop === p.id) && p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : frame.sort.flatMap(s => properties.filter(p => p.id === s.prop));
  const move = ([source]: number[], destination: number) => {
    if (source === undefined || source === destination || source + 1 === destination) return;
    const after = source < destination;
    const item = items[source], target = items[after ? destination - 1 : destination];
    if (item && target) onAction({ action: mode === "sortOrder" ? "sort" : "properties",
      viewId, operation: "move", propertyId: item.id, targetId: target.id, where: after ? "after" : "before" });
  };
  return <Group modifiers={[presentationDetents(["medium", "large"]), presentationDragIndicator("visible")]}>
    <VStack spacing={0}>
      <HStack modifiers={[padding({ horizontal: 20, top: 20, bottom: 8 })]}>
        <Text modifiers={[font({ textStyle: "headline" })]}>{searching ? labels.search : labels.reorder}</Text>
        <Spacer /><Button label={labels.done} onPress={close} />
      </HStack>
      {searching && <TextField placeholder={labels.search} autoFocus onTextChange={setQuery} modifiers={[padding({ horizontal: 20, vertical: 8 })]} />}
      <List modifiers={searching ? [] : [environment("editMode", "active")]}>
        <List.ForEach data={items} keyExtractor={p => p.id} onMove={searching ? undefined : move}>
          {({ item }) => searching
            ? <Button label={item.name} systemImage={iconFor(item.type)} onPress={() => {
                onAction({ action: "sort", viewId, operation: "set", propertyId: item.id, desc: false });
                close();
              }} />
            : <Label title={item.name} systemImage={iconFor(item.type)} />}
        </List.ForEach>
        {searching && !items.length && <Text>{labels.empty}</Text>}
      </List>
    </VStack>
  </Group>;
}
