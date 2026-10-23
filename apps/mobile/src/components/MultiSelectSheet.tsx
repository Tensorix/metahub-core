import { BottomSheet, Button, Checkbox, Column, Host, Text } from "@expo/ui";
import { useRef, useState } from "react";

/** Multi-select editor: checkbox list in a native bottom sheet. Selection is
 *  optimistic local state (seeded on mount) so rapid toggles never rebuild
 *  from a stale server snapshot; each change reports the full next array. */
export function MultiSelectSheet({
  isPresented,
  onDismiss,
  title,
  options,
  initialSelected,
  onChange,
}: {
  isPresented: boolean;
  onDismiss: () => void;
  title: string;
  options: string[];
  initialSelected: string[];
  onChange: (next: string[]) => void;
}) {
  const [selected, setSelected] = useState(initialSelected);

  const latest = useRef(selected);

  const toggle = (opt: string, checked: boolean) => {
    const next = checked ? [...new Set([...latest.current, opt])] : latest.current.filter((o) => o !== opt);
    latest.current = next;
    setSelected(next);
    onChange(next);
  };

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
              onValueChange={(checked) => toggle(opt, checked)}
            />
          ))}
          <Button variant="text" label="完成" onPress={onDismiss} />
        </Column>
      </BottomSheet>
    </Host>
  );
}
