import { NativeMenu } from "../native/NativeMenu";
export function RangeMenu({
  onAction,
}: {
  onAction(kind: "copy" | "paste" | "fill" | "clear"): void;
}) {
  return (
    <NativeMenu
      label="选区操作"
      items={(["copy", "paste", "fill", "clear"] as const).map((kind, i) => ({
        id: kind,
        title: ["复制", "粘贴", "向下填充", "清空"][i]!,
        onPress: () => onAction(kind),
      }))}
    />
  );
}
