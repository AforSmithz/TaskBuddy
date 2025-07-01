import { cn } from "@/lib/cn";
import { STATUS_LABELS, type PriorityLabel, type TaskStatus } from "@/lib/types";

// --- Priority badge ---------------------------------------------------------

const PRIORITY_STYLE: Record<PriorityLabel, { wrap: string; dot: string }> = {
  Critical: {
    wrap: "bg-[var(--color-priority-critical-subtle)] text-[var(--color-priority-critical-fg)]",
    dot: "bg-[var(--color-priority-critical)]",
  },
  High: {
    wrap: "bg-[var(--color-priority-high-subtle)] text-[var(--color-priority-high-fg)]",
    dot: "bg-[var(--color-priority-high)]",
  },
  Medium: {
    wrap: "bg-[var(--color-priority-medium-subtle)] text-[var(--color-priority-medium-fg)]",
    dot: "bg-[var(--color-priority-medium)]",
  },
  Low: {
    wrap: "bg-[var(--color-priority-low-subtle)] text-[var(--color-priority-low-fg)]",
    dot: "bg-[var(--color-priority-low)]",
  },
  Backlog: {
    wrap: "bg-[var(--color-priority-backlog-subtle)] text-[var(--color-priority-backlog-fg)]",
    dot: "bg-[var(--color-priority-backlog)]",
  },
};

export function PriorityBadge({
  label,
  score,
  className,
}: {
  label: PriorityLabel | null;
  score?: number | null;
  className?: string;
}) {
  const style = PRIORITY_STYLE[label ?? "Backlog"];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 h-5 px-1.5 rounded-xs",
        "text-[11px] font-semibold uppercase tracking-[0.04em]",
        style.wrap,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full shrink-0", style.dot)} />
      {label ?? "Backlog"}
      {typeof score === "number" && (
        <span className="font-mono font-medium opacity-70">
          {score.toFixed(2)}
        </span>
      )}
    </span>
  );
}

// --- Status badge -----------------------------------------------------------

const STATUS_STYLE: Record<TaskStatus, string> = {
  backlog:
    "bg-[var(--color-status-backlog-subtle)] text-[var(--color-status-backlog-fg)] border-[var(--color-status-backlog)]",
  todo: "bg-[var(--color-status-todo-subtle)] text-[var(--color-status-todo-fg)] border-[var(--color-status-todo)]",
  in_progress:
    "bg-[var(--color-status-in-progress-subtle)] text-[var(--color-status-in-progress-fg)] border-[var(--color-status-in-progress)]",
  blocked:
    "bg-[var(--color-status-blocked-subtle)] text-[var(--color-status-blocked-fg)] border-[var(--color-status-blocked)]",
  review:
    "bg-[var(--color-status-review-subtle)] text-[var(--color-status-review-fg)] border-[var(--color-status-review)]",
  done: "bg-[var(--color-status-done-subtle)] text-[var(--color-status-done-fg)] border-[var(--color-status-done)]",
};

export function StatusBadge({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 pl-2 pr-2 rounded-xs border-l-2",
        "text-[11px] font-medium",
        STATUS_STYLE[status],
        className,
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

// --- Plain pill -------------------------------------------------------------

export function Pill({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 px-2 rounded-xs text-[11px] font-medium",
        "bg-[var(--color-surface-overlay)] text-[var(--color-fg-muted)]",
        className,
      )}
    >
      {children}
    </span>
  );
}
