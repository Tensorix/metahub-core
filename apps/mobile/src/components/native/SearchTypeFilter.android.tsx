import { FilterChip, Row, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { NativeHost } from "./NativeHost";
import type { SearchTypeFilterProps } from "./SearchTypeFilter";

const options = [
  { label: "全部", kind: undefined },
  { label: "文档", kind: "document" },
  { label: "数据表", kind: "record" },
] as const;

export function SearchTypeFilter({ value, onChange }: SearchTypeFilterProps) {
  return <NativeHost matchContents={{ vertical: true }} style={{ minHeight: 48 }}>
    <Row horizontalArrangement={{ spacedBy: 8 }} modifiers={[fillMaxWidth()]}>
      {options.map(({ label, kind }) => (
        <FilterChip key={label} selected={value === kind} onClick={() => onChange(kind)}>
          <FilterChip.Label><Text>{label}</Text></FilterChip.Label>
        </FilterChip>
      ))}
    </Row>
  </NativeHost>;
}
