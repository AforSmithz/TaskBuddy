import { Coffee } from "lucide-react";
import type { ScheduleBlock } from "@/lib/types";

export function ScheduleTimeline({ blocks }: { blocks: ScheduleBlock[] }) {
  if (blocks.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
        No schedulable tasks — everything is done or blocked.
      </p>
    );
  }

  return (
    <ol className="p-5">
      {blocks.map((block, i) => {
        const isBuffer = block.task_id === null;
        return (
          <li key={block.id} className="flex gap-3">
            {/* Time + connector */}
            <div className="flex w-[52px] shrink-0 flex-col items-end">
              <span className="font-mono text-[12px] text-[var(--color-fg-muted)]">
                {block.start_time}
              </span>
            </div>
            <div className="flex flex-col items-center">
              <span
                className={
                  isBuffer
                    ? "size-2 rounded-full bg-[var(--color-fg-subtle)]"
                    : "size-2 rounded-full bg-[var(--color-accent)]"
                }
              />
              {i < blocks.length - 1 && (
                <span className="w-px flex-1 bg-[var(--color-border)]" />
              )}
            </div>
            {/* Content */}
            <div className="min-w-0 flex-1 pb-4">
              <div className="rounded-sm bg-[var(--color-surface-raised)] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg)]">
                    {isBuffer && (
                      <Coffee className="size-3.5 text-[var(--color-fg-subtle)]" />
                    )}
                    {block.label}
                  </p>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-subtle)]">
                    {block.start_time}–{block.end_time}
                  </span>
                </div>
                {block.reason && (
                  <p className="mt-0.5 text-[12px] text-[var(--color-fg-muted)]">
                    {block.reason}
                  </p>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
