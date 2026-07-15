"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Coffee, GripVertical, TriangleAlert } from "lucide-react";
import type { ScheduleDay, ScheduledBlock } from "@/lib/schedule";
import { reorderTodayAction } from "@/lib/actions";
import { formatMinutes } from "@/lib/format";
import { cn } from "@/lib/cn";

/** A stable hue per project id so each project reads as one color across the plan (mirrors the
 *  read-only `ScheduleTimeline`; replicated rather than shared to keep this client bundle from
 *  importing the server component). */
function projectHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** The task-id sequence of the draggable (real-task) blocks, in render order. */
function taskOrder(blocks: ScheduledBlock[]): string[] {
  return blocks
    .filter((b) => b.task_id !== null)
    .map((b) => b.task_id as string);
}

/**
 * Today's plan, reorderable by drag (OVERHAUL §5a substrate S3c-5 §6). Native HTML5 DnD over the
 * real-task blocks only (buffers stay put - they're computed slack, not user-orderable), mirroring
 * the kanban's drag pattern with no new dependency. A drop optimistically resequences the list and
 * calls `reorderTodayAction`, which honors the order as a preference seed and - when it's
 * odds-neutral - teaches the arrangement weights. The client computes NO odds: it records an order,
 * the server re-prices and gates (Hard Rule §2.8 / design invariant 3). Upcoming days stay
 * display-only (`ScheduleTimeline`); v1 reorders today only.
 */
export function TodayReorder({
  day,
  todayISO,
}: {
  day: ScheduleDay;
  todayISO: string;
}) {
  const blocks = day.blocks;
  const remaining = day.capacityMinutes - day.usedMinutes;
  const byId = new Map(
    blocks.filter((b) => b.task_id !== null).map((b) => [b.task_id as string, b]),
  );
  const buffers = blocks.filter((b) => b.task_id === null);

  // The displayed order. Seeded from the server's blocks and reset whenever the committed order
  // changes (a new server render) - an optimistic drop updates this immediately, and the following
  // revalidation either confirms it or corrects it (e.g. a task went stale).
  const serverOrder = taskOrder(blocks);
  const [order, setOrder] = useState<string[]>(serverOrder);
  const serverKey = serverOrder.join(",");
  const syncedKey = useRef(serverKey);
  useEffect(() => {
    if (syncedKey.current !== serverKey) {
      syncedKey.current = serverKey;
      setOrder(serverOrder);
    }
    // serverOrder is derived from serverKey; keying the effect on the string avoids array churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function commit(next: string[]) {
    setOrder(next);
    setNote(null);
    startTransition(async () => {
      const { oddsCost } = await reorderTodayAction(todayISO, next);
      // Server signal only - the client never computes the odds, it just surfaces the note.
      setNote(oddsCost ? "This order costs some odds." : null);
    });
  }

  function onDrop(targetId: string) {
    const from = order.indexOf(dragId ?? "");
    const to = order.indexOf(targetId);
    setDragId(null);
    setOverId(null);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit(next);
  }

  return (
    <div className="space-y-3 p-5">
      <ul className="space-y-1">
        {order.map((id) => {
          const block = byId.get(id);
          if (!block) return null;
          return (
            <li
              key={id}
              draggable
              onDragStart={(e) => {
                setDragId(id);
                e.dataTransfer.setData("text/plain", id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragId && dragId !== id) setOverId(id);
              }}
              onDragLeave={() => setOverId((o) => (o === id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(id);
              }}
              className={cn(
                "flex cursor-grab items-center justify-between gap-3 rounded-sm bg-[var(--color-surface-raised)] px-3 py-2 transition-colors active:cursor-grabbing",
                dragId === id && "opacity-50",
                overId === id
                  ? "ring-2 ring-[var(--color-accent-subtle)]"
                  : "ring-0",
              )}
            >
              <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg)]">
                <GripVertical className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
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

        {/* Buffers are computed slack, not user-orderable - shown static, after the tasks. */}
        {buffers.map((block, i) => (
          <li
            key={`buffer-${i}`}
            className="flex items-center justify-between gap-3 rounded-sm bg-[var(--color-surface-raised)] px-3 py-2"
          >
            <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg)]">
              <Coffee className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
              <span className="truncate" title={block.reason}>
                {block.label}
              </span>
            </p>
            <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-subtle)]">
              {formatMinutes(block.minutes)}
            </span>
          </li>
        ))}
      </ul>

      {/* How the day landed against its capacity (parity with ScheduleTimeline). */}
      {remaining > 0 ? (
        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          {formatMinutes(remaining)} left
        </p>
      ) : remaining < 0 ? (
        <p className="text-[11px] text-[var(--color-danger)]">
          {formatMinutes(-remaining)} over capacity
        </p>
      ) : null}

      {note && (
        <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-danger)]">
          <TriangleAlert className="size-3.5 shrink-0" />
          {note}
        </p>
      )}
    </div>
  );
}
