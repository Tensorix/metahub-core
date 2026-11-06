import { ListItem, Text } from "@expo/ui";
export function SettingsRow({ title, value, onPress }: {title:string;value?:string;icon:string;onPress:()=>void}) { return <ListItem onPress={onPress} supportingText={value} trailing={<Text>›</Text>}>{title}</ListItem>; }
