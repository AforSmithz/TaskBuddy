import Link from "next/link";
import { CalendarDays, ListChecks, ChevronRight, Target } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { EntryKind } from "@/lib/types";

export function EntryListItem({
  id,
  title,
  summary,
  createdAt,
  taskCount,
  openCount,
  kind,
}: {
  id: string;
  title: string;
  summary: string | null;
  createdAt: string;
  taskCount: number;
  openCount: number;
  kind?: EntryKind;
}) {
  return (
    <Link
      href={`/entries/${id}`}
      className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--color-surface-raised)]"
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-[14px] font-semibold text-[var(--color-fg)]">
          {kind === "plan" && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-xs bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-fg)]">
              <Target className="size-3" />
              Goal
            </span>
          )}
          <span className="truncate">{title}</span>
        </p>
        {summary && (
          <p className="mt-0.5 truncate text-[13px] text-[var(--color-fg-muted)]">
            {summary}
          </p>
        )}
      </div>
      <div className="hidden shrink-0 items-center gap-4 text-[12px] text-[var(--color-fg-muted)] sm:flex">
        <span className="flex items-center gap-1.5">
          <ListChecks className="size-3.5" />
          {openCount}/{taskCount} open
        </span>
        <span className="flex items-center gap-1.5">
          <CalendarDays className="size-3.5" />
          {formatDate(createdAt)}
        </span>
      </div>
      <ChevronRight className="size-4 shrink-0 text-[var(--color-fg-subtle)] transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
