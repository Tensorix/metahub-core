import { TextInput } from "react-native";
import type { ReactNode } from "react";

export function SectionSearch({ placeholder, children: _children, ...props }: { placeholder: string; value: string; onChangeText: (value: string) => void; children?: (close: () => void) => ReactNode }) {
  return <TextInput {...props} placeholder={placeholder} />;
}
