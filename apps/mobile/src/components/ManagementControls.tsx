import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { NativeHost } from "@/components/native/NativeHost";
import { NativeButton } from "@/components/native/NativeButton";
import { RecordTextInput } from "@/components/RecordTextInput";
import { useTheme } from "@/lib/theme";

export function ManagementInput({
  label,
  value,
  onChange,
  multiline = false,
  disabled = false,
  secureTextEntry = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  disabled?: boolean;
  secureTextEntry?: boolean;
}) {
  const { tokens } = useTheme();
  return (
    <View style={{ gap: 6, paddingVertical: 8 }}>
      <Text style={{ color: tokens.muted }}>{label}</Text>
      <NativeHost matchContents style={{ minHeight: 44 }}>
        <RecordTextInput
          editable={!disabled}
          secureTextEntry={secureTextEntry}
          text={value}
          onChangeText={onChange}
          placeholder={label}
          multiline={multiline}
          style={{ padding: 12 }}
        />
      </NativeHost>
    </View>
  );
}
export function ManagementSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { tokens } = useTheme();
  return (
    <View
      style={{
        gap: 8,
        paddingVertical: 16,
        borderTopWidth: 1,
        borderColor: tokens.line,
      }}
    >
      <Text style={{ fontSize: 18, color: tokens.fg, fontWeight: "600" }}>
        {title}
      </Text>
      {children}
    </View>
  );
}
export function ManagementAction({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <NativeButton variant="text" disabled={disabled} onPress={onPress}>
      {label}
    </NativeButton>
  );
}
