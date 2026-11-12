export interface SelectionItem {
  id: string;
  title: string;
  selected: boolean;
  canOpen?: boolean;
}
export interface SelectionNotice {
  text: string;
  action?: { label: string; onPress: () => void };
}
export interface SelectionSheetProps {
  title: string;
  isPresented?: boolean;
  onClose: () => void;
  busy?: boolean;
  items: SelectionItem[];
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  search?: {
    value: string;
    placeholder: string;
    onChange: (value: string) => void;
  };
  summary: string;
  loading?: boolean;
  notices?: SelectionNotice[];
  pagination?: {
    page: number;
    hasPrevious: boolean;
    hasNext: boolean;
    onPrevious: () => void;
    onNext: () => void;
  };
  empty?: string;
  testID?: string;
}
