import { TextInput } from "react-native";

export function LibrarySearch(props: { value: string; onChangeText: (value: string) => void }) {
  return <TextInput {...props} placeholder="搜索资料库" />;
}
