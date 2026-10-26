export interface NativeMenuItem {
  id: string;
  title: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

export interface NativeMenuProps {
  label: string;
  items: NativeMenuItem[];
  testID?: string;
}
