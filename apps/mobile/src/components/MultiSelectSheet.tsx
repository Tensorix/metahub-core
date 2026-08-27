import { BottomSheet, Button, Checkbox, Column, Host, Text } from "@expo/ui";

/** Multi-select editor: checkbox list in a native bottom sheet. */
export function MultiSelectSheet({
  isPresented,
  onDismiss,
  title,
  options,
  selected,
  onToggle,
}: {
  isPresented: boolean;
  onDismiss: () => void;
  title: string;
  options: string[];
  selected: string[];
  onToggle: (option: string, checked: boolean) => void;
}) {
  return (
    <Host>
      <BottomSheet isPresented={isPresented} onDismiss={onDismiss}>
        <Column>
          <Text>{title}</Text>
          {options.map((opt) => (
            <Checkbox
              key={opt}
              label={opt}
              value={selected.includes(opt)}
              onValueChange={(checked) => onToggle(opt, checked)}
            />
          ))}
          <Button variant="text" label="完成" onPress={onDismiss} />
        </Column>
      </BottomSheet>
    </Host>
  );
}
