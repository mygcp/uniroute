import { Menu, Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/use-theme";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

const buttonClasses = "border-glass-border text-muted-foreground hover:bg-glass hover:text-foreground";

export function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const { theme, toggle } = useTheme();

  return (
    <header className="sticky top-0 z-40 flex items-center justify-between border-b border-glass-border bg-background/60 px-3 py-3 shadow-[inset_0_1px_0_var(--glass-highlight)] backdrop-blur sm:px-4 md:px-6">
      <Button
        type="button"
        onClick={onMenuClick}
        aria-label="Open menu"
        size="icon"
        variant="ghost"
        className={`border ${buttonClasses} md:hidden`}
      >
        <Menu size={20} />
      </Button>
      <div className="flex flex-1 items-center justify-end gap-2">
        <Tooltip label={theme === "dark" ? "Light mode" : "Dark mode"}>
          <Button
            type="button"
            onClick={toggle}
            size="icon"
            variant="ghost"
            className={`border ${buttonClasses}`}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}