import { cn } from "@/lib/cn";

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xs",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  icon,
  action,
  className,
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-5 py-3.5",
        "border-b border-[var(--color-border)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {icon && (
          <span className="text-[var(--color-fg-muted)] shrink-0">{icon}</span>
        )}
        <h2 className="text-[15px] font-semibold text-[var(--color-fg)] truncate">
          {title}
        </h2>
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("p-5", className)}>{children}</div>;
}
