import { BottomSheet, Button, Column, Host, Picker, Text } from "@expo/ui";

import type { PropInfo } from "@/lib/api/sdk";

export interface SortSpec {
  propId: string;
  name: string;
  dir: "asc" | "desc";
}

const DEFAULT = "__created__";

/** Sort chooser: native bottom sheet (SwiftUI sheet / M3 ModalBottomSheet)
 *  with a property picker and direction toggle. */
export function SortSheet({
  isPresented,
  onDismiss,
  props,
  sort,
  onChange,
}: {
  isPresented: boolean;
  onDismiss: () => void;
  props: PropInfo[];
  sort: SortSpec | null;
  onChange: (sort: SortSpec | null) => void;
}) {
  const pick = (propId: string, dir: "asc" | "desc") => {
    if (propId === DEFAULT) {
      onChange(null);
      return;
    }
    const prop = props.find((p) => p.id === propId);
    if (prop) onChange({ propId: prop.id, name: prop.name, dir });
  };

  return (
    <Host>
      <BottomSheet isPresented={isPresented} onDismiss={onDismiss}>
        <Column>
          <Text>排序方式</Text>
          <Picker
            selectedValue={sort?.propId ?? DEFAULT}
            onValueChange={(v) => pick(String(v), sort?.dir ?? "asc")}
          >
            <Picker.Item label="默认（创建顺序）" value={DEFAULT} />
            {props.map((p) => (
              <Picker.Item key={p.id} label={p.name} value={p.id} />
            ))}
          </Picker>
          <Picker
            selectedValue={sort?.dir ?? "asc"}
            onValueChange={(v) =>
              sort ? pick(sort.propId, v === "desc" ? "desc" : "asc") : undefined
            }
            enabled={sort !== null}
          >
            <Picker.Item label="升序" value="asc" />
            <Picker.Item label="降序" value="desc" />
          </Picker>
          <Button variant="text" onPress={onDismiss} label="完成" />
        </Column>
      </BottomSheet>
    </Host>
  );
}
