import * as React from "react";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Sun, Moon, Monitor } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider
} from "@/components/ui/tooltip";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    if (theme === "light") { setTheme("dark"); }
    else if (theme === "dark") { setTheme("system"); }
    else { setTheme("light"); }
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={cycleTheme}
            className="size-8"
          >
            {theme === "light" && <Sun className="size-[1.2rem] scale-100 transition-all" />}
            {theme === "dark" && <Moon className="size-[1.2rem] scale-100 transition-all text-blue-400" />}
            {theme === "system" && <Monitor className="size-[1.2rem] scale-100 transition-all text-primary" />}
            <span className="sr-only">Toggle theme</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Theme: {theme.charAt(0).toUpperCase() + theme.slice(1)}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

