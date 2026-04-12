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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-8"
              >
                {theme === "light" && <Sun className="size-[1.2rem] scale-100 transition-all" />}
                {theme === "dark" && <Moon className="size-[1.2rem] scale-100 transition-all text-blue-400" />}
                {theme === "system" && <Monitor className="size-[1.2rem] scale-100 transition-all text-primary" />}
                <span className="sr-only">Select theme</span>
              </Button>
            </TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">Theme: {theme.charAt(0).toUpperCase() + theme.slice(1)}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="mr-2 size-4" />
          <span>Light</span>
          {theme === "light" && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="mr-2 size-4" />
          <span>Dark</span>
          {theme === "dark" && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor className="mr-2 size-4" />
          <span>System</span>
          {theme === "system" && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

