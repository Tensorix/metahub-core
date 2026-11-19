import type { DatabaseToolbarCommand, DatabaseToolbarFrame } from "../../../../src/shared/views/database-source";

export interface DatabaseGlassToolbarProps {
  frame: DatabaseToolbarFrame;
  bottomInset: number;
  onAction(command: DatabaseToolbarCommand): void;
}

export function DatabaseGlassToolbar(_props: DatabaseGlassToolbarProps) {
  return null;
}
