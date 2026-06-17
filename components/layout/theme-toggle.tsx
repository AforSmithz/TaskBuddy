"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";

/**
 * Flips `:root[data-theme]` between dark and light and remembers the choice in
 * localStorage. The initial paint is handled by the inline script in the root
 * layout, so this just syncs the icon to whatever is already applied.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  // Sync the icon to whatever the pre-hydration inline script already applied to
  // <html>. Reading the DOM can only happen after mount, so a one-shot setState
  // here is the intended pattern for this case.
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current === "light" || current === "dark") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTheme(current);
    }
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("tb-theme", next);
    } catch {
      // ignore (private mode / storage disabled)
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title="Toggle theme"
      aria-label="Toggle theme"
      className="flex size-10 items-center justify-center rounded-[13px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
    >
      {theme === "dark" ? (
        <Moon className="size-[18px]" strokeWidth={1.7} />
      ) : (
        <Sun className="size-[18px]" strokeWidth={1.7} />
      )}
    </button>
  );
}
