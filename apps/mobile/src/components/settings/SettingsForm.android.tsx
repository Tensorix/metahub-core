import { Column, ScrollView } from "@expo/ui";
import type { PropsWithChildren } from "react";

export function SettingsForm({ children }: PropsWithChildren) {
  return <ScrollView style={{ width: "100%", height: "100%" }}>
    <Column style={{ width: "100%", paddingBottom: 24 }}>{children}</Column>
  </ScrollView>;
}
