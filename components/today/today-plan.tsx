"use client";

import { useState } from "react";
import { CalendarRange, ChevronDown, CalendarOff } from "lucide-react";
import type { ScheduleDay } from "@/lib/schedule";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ScheduleTimeline } from "@/components/entries/schedule-timeline";
import { TodayReorder } from "@/components/today/today-reorder";
import { formatMinutes } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * The unified, cross-project schedule for the Today page: today's slice across
 * every project, with the rest of the global plan tucked behind a disclosure.
 * It renders the single allocation the agenda also ranks by - same plan, packed
 * into the day's shared hour-budget instead of a flat list.
 */
export function TodayPlan({
  days,
  todayISO,
}: {
  days: ScheduleDay[];
  todayISO: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const todaySlice = days.find((d) => d.date === todayISO);
  const upcoming = days.filter((d) => d.date > todayISO);
  const bookedToday = todaySlice?.usedMinutes ?? 0;

  return (
    <Card>
      <CardHeader
        title="Today's plan"
        icon={<CalendarRange className="size-4" />}
        action={
          bookedToday > 0 ? (
            <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-subtle)]">
              {formatMinutes(bookedToday)} booked
            </span>
          ) : undefined
        }
      />

      {days.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={CalendarRange}
            title="Nothing to schedule"
            description="No open, unblocked work across your goals right now."
          />
        </div>
      ) : (
        <>
          {todaySlice ? (
                     // Today's blocks are drag-to-reorderable; upcoming days stay display-only.
            <TodayReorder day={todaySlice} todayISO={todayISO} />
          ) : (
            <div className="px-5 py-6">
              <p className="flex items-center justify-center gap-2 text-center text-[13px] text-[var(--color-fg-subtle)]">
                <CalendarOff className="size-4 shrink-0" />
                Nothing scheduled today — no deployable hours. Next up below.
              </p>
            </div>
          )}

          {upcoming.length > 0 && (
            <div className="border-t border-[var(--color-border)]">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="flex w-full items-center justify-between gap-2 px-5 py-3 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
              >
                <span>
                  Next {upcoming.length} {upcoming.length === 1 ? "day" : "days"}
                </span>
                <ChevronDown
                  className={cn(
                    "size-4 shrink-0 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                />
              </button>
              {expanded && <ScheduleTimeline days={upcoming} />}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
