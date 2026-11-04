import {
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Text,
} from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { NativeHost } from "./NativeHost";
import type { LibrarySwitchProps } from "./LibrarySwitch.types";
export function LibrarySwitch({ value, onChange }: LibrarySwitchProps) {
  return (
    <NativeHost matchContents={{ vertical: true }} style={{ minHeight: 48 }}>
      <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
        {(["documents", "databases"] as const).map((kind) => (
          <SegmentedButton
            key={kind}
            selected={value === kind}
            onClick={() => onChange(kind)}
          >
            <SegmentedButton.Label>
              <Text>{kind === "documents" ? "文档" : "数据表"}</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
        ))}
      </SingleChoiceSegmentedButtonRow>
    </NativeHost>
  );
}
