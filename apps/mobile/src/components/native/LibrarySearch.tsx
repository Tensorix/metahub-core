import { TextInput } from "react-native";
import type { ReactNode } from "react";

export function LibrarySearch({ children: _children, ...props }: { value: string; onChangeText: (value: string) => void; children?: (close: () => void) => ReactNode }) {
  return <TextInput {...props} placeholder="搜索资料库" />;
}
