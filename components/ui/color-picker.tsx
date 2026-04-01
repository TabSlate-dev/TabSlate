import { cn } from "@/lib/utils";
import { TAB_GROUP_COLOR_KEYS, TAB_GROUP_COLORS, type TabGroupColor } from "@/lib/chrome/tab-groups";

interface ColorPickerProps {
  value: TabGroupColor;
  onChange: (color: TabGroupColor) => void;
  /** Dot size. "sm" = size-4, "md" = size-5. Defaults to "md". */
  size?: "sm" | "md";
}

export function ColorPicker({ value, onChange, size = "md" }: ColorPickerProps) {
  const dotClass = size === "sm" ? "size-4" : "size-5";
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {TAB_GROUP_COLOR_KEYS.map((color) => (
        <button
          key={color}
          type="button"
          title={color}
          onClick={() => onChange(color)}
          className={cn(
            dotClass,
            "rounded-full transition-all hover:scale-110 ring-offset-1",
            value === color && "ring-2 ring-offset-background"
          )}
          style={{
            backgroundColor: TAB_GROUP_COLORS[color],
            outline: value === color ? `2px solid ${TAB_GROUP_COLORS[color]}` : "none",
            outlineOffset: "2px",
          }}
        />
      ))}
    </div>
  );
}
