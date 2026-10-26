import type { ImageSourcePropType } from "react-native";

export interface MaterialFabProps {
  label: string;
  onPress: () => void;
  icon?: ImageSourcePropType;
}
