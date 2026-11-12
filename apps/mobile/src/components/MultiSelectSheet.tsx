import { SelectionSheet } from "./native/SelectionSheet";
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
    const next = checked
      ? [...new Set([...latest.current, opt])]
      : latest.current.filter((o) => o !== opt);
    latest.current = next;
    setSelected(next);
    onChange(next);
  };

  return (
    <SelectionSheet
      title={title}
      isPresented={isPresented}
      onClose={onDismiss}
      summary={`已选 ${selected.length} 项`}
      onSelect={(option) => toggle(option, !latest.current.includes(option))}
      items={options.map((option) => ({
        id: option,
        title: option,
        selected: selected.includes(option),
      }))}
      empty="没有可选项"
    />
  );
}
