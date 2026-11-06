import { Button, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { buttonStyle, foregroundStyle, lineLimit, truncationMode } from "@expo/ui/swift-ui/modifiers";
export function SettingsRow({ title, value, icon, onPress }: {title:string;value?:string;icon: "sun.max" | "internaldrive" | "folder" | "arrow.triangle.2.circlepath" | "info.circle";onPress:()=>void}) {
 return <Button onPress={onPress} modifiers={[buttonStyle("plain")]}><HStack spacing={12}><Image systemName={icon} size={20}/><VStack alignment="leading"><Text>{title}</Text>{value && <Text modifiers={[lineLimit(1), truncationMode("middle"), foregroundStyle({type:"hierarchical",style:"secondary"})]}>{value}</Text>}</VStack><Spacer/><Image systemName="chevron.right" size={12}/></HStack></Button>;
}
