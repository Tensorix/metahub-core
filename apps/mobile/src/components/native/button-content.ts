import type { ButtonProps } from "@expo/ui";
import { Children } from "react";

/** Native buttons require a label prop or a native view, never a raw text child. */
export function nativeButtonContent(
  label: ButtonProps["label"],
  children: ButtonProps["children"],
): Pick<ButtonProps, "label" | "children"> {
  if (typeof children === "string" || typeof children === "number") {
    return { label: String(children) };
  }
  if (children == null || typeof children === "boolean") return { label };
  if (Array.isArray(children)) {
    const parts = Children.toArray(children);
    if (!parts.length) return { label };
    if (parts.every((part) => typeof part === "string" || typeof part === "number"))
      return { label: parts.join("") };
  }
  return { label, children };
}
