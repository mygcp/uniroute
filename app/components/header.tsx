import { useState } from "react";
import { Menu, Moon, Sun } from "lucide-react";

export function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const [dark, setDark] = useState<boolean>(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("uniroute-theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  };

  return (
    <header className="flex items-center justify-between px-3 py-3 sm:px-4 md:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open menu"
        className="rounded-lg border border-gray-200 p-2 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 md:hidden"
      >
        <Menu size={20} />
      </button>
      <div className="flex flex-1 items-center justify-end gap-2">
        <button
          type="button"
          onClick={toggleDark}
          title={dark ? "Light mode" : "Dark mode"}
          className="rounded-lg border border-gray-200 p-2 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}
