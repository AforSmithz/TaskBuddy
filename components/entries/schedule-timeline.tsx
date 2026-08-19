import { Coffee } from "lucide-react";
import type { ScheduleDay } from "@/lib/schedule";
import { formatMinutes } from "@/lib/format";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** ISO "2026-05-26" -> "Tue, May 26" (parsed as UTC, so no timezone drift). */
function formatDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

function projectHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function ScheduleTimeline({ days }: { days: ScheduleDay[] }) {
  if (days.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
        No schedulable tasks — everything is done or blocked.
      </p>
    );
  }

  return (
    <div className="space-y-4 p-5">
      {days.map((day) => {
        const remaining = day.capacityMinutes - day.usedMinutes;
        return (
          <div key={day.date}>
            <div className="flex items-baseline justify-between gap-2 pb-1.5">
              <p className="text-[12px] font-semibold text-[var(--color-fg)]">
                {formatDay(day.date)}
              </p>
              <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                {formatMinutes(day.capacityMinutes)} free
              </span>
            </div>

            <ul className="space-y-1">
              {day.blocks.map((block, i) => {
                const isBuffer = block.task_id === null;
                return (
                  <li
                    key={block.task_id ?? `buffer-${i}`}
                    className="flex items-center justify-between gap-3 rounded-sm bg-[var(--color-surface-raised)] px-3 py-2"
                  >
                    <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg)]">
                      {isBuffer && (
                        <Coffee className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
                      )}
                      {/* Goal tag - only on global (cross-project) schedules. */}
                      {block.projectId && block.projectName && (
                        <span
                          className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-[var(--color-fg-muted)]"
                          title={block.projectName}
                        >
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: `hsl(${projectHue(block.projectId)} 60% 55%)`,
                            }}
                          />
                          <span className="max-w-[120px] truncate">
                            {block.projectName}
                          </span>
                        </span>
                      )}
                      <span className="truncate" title={block.reason}>
                        {block.label}
                      </span>
                    </p>
                    <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-subtle)]">
                      {formatMinutes(block.minutes)}
                    </span>
                  </li>
                );
              })}
            </ul>

            {/* How the day landed against its capacity. */}
            {remaining > 0 ? (
              <p className="pt-1 text-[11px] text-[var(--color-fg-subtle)]">
                {formatMinutes(remaining)} left
              </p>
            ) : remaining < 0 ? (
              <p className="pt-1 text-[11px] text-[var(--color-danger)]">
                {formatMinutes(-remaining)} over capacity
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
