import { Search } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The shell's top bar: a time-of-day greeting + date on the left, a search
 * affordance and the theme toggle on the right. Mirrors Direction F.
 */
export function TopBar({ firstName }: { firstName: string }) {
  const now = new Date();
  const date = now.toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="leading-tight">
        <p className="text-[21px] font-bold tracking-[-0.01em] text-[var(--color-fg)]">
          {greeting(now)}, {firstName}
        </p>
        <p className="mt-0.5 text-[15px] font-medium text-[var(--color-fg-muted)]">
          {date}
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="hidden items-center gap-2.5 rounded-[13px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[13.5px] text-[var(--color-fg-subtle)] sm:flex">
          <Search className="size-4" strokeWidth={1.7} />
          <span className="min-w-[120px]">Search</span>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}
