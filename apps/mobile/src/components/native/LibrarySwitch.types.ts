export type LibraryKind = "documents" | "databases";
export interface LibrarySwitchProps {
  value: LibraryKind;
  onChange: (value: LibraryKind) => void;
}
