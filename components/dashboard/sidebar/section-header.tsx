import type * as React from "react";
import { ChevronDown } from "lucide-react";
import { SidebarGroupLabel } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}

export function SectionHeader({ label, open, onToggle, actions }: SectionHeaderProps) {
  return (
    <SidebarGroupLabel className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
      <button onClick={onToggle} className="flex items-center gap-1.5 cursor-pointer">
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        {label}
      </button>
      {actions}
    </SidebarGroupLabel>
  );
}
