import { Button, Picker } from "@expo/ui";

export interface ConnectionChoiceProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  options: { value: T; label: string }[];
}

/** These controls live inside the form's NativeHost. */
export function ConnectionChoice<T extends string>(
  props: ConnectionChoiceProps<T>,
) {
  return (
    <Picker
      selectedValue={props.value}
      onValueChange={props.onChange}
      enabled={!props.disabled}
    >
      {props.options.map((option) => (
        <Picker.Item key={option.value} {...option} />
      ))}
    </Picker>
  );
}

export interface ConnectionActionProps {
  secondary?: boolean;
  label: string;
  disabled: boolean;
  onPress: () => void;
}

export function ConnectionAction({
  secondary,
  ...props
}: ConnectionActionProps) {
  return (
    <Button
      {...props}
      variant={secondary ? "text" : "filled"}
      style={{ width: "100%", paddingVertical: 12 }}
    />
  );
}
