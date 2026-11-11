import { DockedSearchBar, Icon, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { NativeHost } from "./NativeHost";

// Docked search keeps the filtered library in place and reports every query edit.
export function LibrarySearch({ onChangeText }: { value: string; onChangeText: (value: string) => void }) {
  return (
    <NativeHost matchContents={{ vertical: true }} style={{ marginHorizontal: 16, marginTop: 8, marginBottom: 12 }}>
      <DockedSearchBar modifiers={[fillMaxWidth()]} onQueryChange={onChangeText}>
        <DockedSearchBar.LeadingIcon>
          <Icon source={require("./assets/db-search.xml")} size={24} />
        </DockedSearchBar.LeadingIcon>
        <DockedSearchBar.Placeholder><Text>搜索资料库</Text></DockedSearchBar.Placeholder>
      </DockedSearchBar>
    </NativeHost>
  );
}
