import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center gap-3 px-6 py-12",
        className,
      )}
    >
      <div className="flex size-14 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
        <Icon className="size-6 text-[var(--color-fg-subtle)]" aria-hidden />
      </div>
      <div className="space-y-1 max-w-xs">
        <p className="text-[15px] font-semibold text-[var(--color-fg)]">
          {title}
        </p>
        {description && (
          <p className="text-[13px] text-[var(--color-fg-muted)] leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
