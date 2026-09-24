import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "../../dashboard/src/components/ui/select";

export function DemoSelect<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Select value={value} onValueChange={value => onChange(value as T)}>
      <SelectTrigger className="demo-select-trigger" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="demo-select-content" align="start" sideOffset={4}>
        <SelectGroup>
          {options.map(option => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
