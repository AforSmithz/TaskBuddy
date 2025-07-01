import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { CountUp } from "@/components/ui/count-up";
import { MotionTile } from "@/components/ui/motion-tile";

export function StatTile({
  label,
  value,
  icon: Icon,
  hint,
  accent = false,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <MotionTile
      className={cn(
        "group rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]",
        "px-5 py-4 shadow-xs transition-shadow duration-200 hover:shadow-md",
      )}
    >
      <div
        className={cn(
          "flex size-8 items-center justify-center rounded-md mb-4",
          "transition-transform duration-200 group-hover:scale-110",
          accent
            ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
            : "bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]",
        )}
      >
        <Icon className="size-[18px]" aria-hidden />
      </div>
      <p className="text-[13px] font-medium text-[var(--color-fg-muted)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold leading-none tabular-nums text-[var(--color-fg)]">
        {typeof value === "number" ? <CountUp value={value} /> : value}
      </p>
      {hint && (
        <p className="mt-1.5 text-xs text-[var(--color-fg-subtle)]">{hint}</p>
      )}
    </MotionTile>
  );
}
