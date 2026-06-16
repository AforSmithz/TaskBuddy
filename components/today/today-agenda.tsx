"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { motion, MotionConfig, AnimatePresence } from "motion/react";
import type { LucideIcon } from "lucide-react";
import {
  ListTodo,
  Sun,
  AlertTriangle,
  Ban,
  Flame,
  Lock,
  Sparkles,
  ArrowRight,
  ArrowUpCircle,
  CheckCircle2,
} from "lucide-react";
import {
  SEED_AREAS,
  type EffectiveOrderEntry,
  type RecurringState,
  type Task,
  type TaskDependency,
  type TaskStatus,
} from "@/lib/types";
import { activityIdFromTaskId, isRecurringTaskId } from "@/lib/recurring";
import { PriorityBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { isOverdue, isToday } from "@/lib/format";
import { cn } from "@/lib/cn";
import { updateTaskStatusAction, updateTaskAreaAction } from "@/lib/actions";
import { TaskRow, RecurringAgendaRow } from "@/components/today/task-row";

const byPriority = (a: Task, b: Task) =>
  (b.priority_score ?? 0) - (a.priority_score ?? 0);

type Patch = { taskId: string; status?: TaskStatus; area?: string };

export function TodayAgenda({
  tasks,
  entryTitles,
  dependencies,
  order = [],
  recurringStateById = {},
}: {
  tasks: Task[];
  entryTitles: Record<string, string>;
  dependencies: TaskDependency[];
  /** The global cross-project order the agenda ranks by (falls back to priority_score if empty). */
  order?: EffectiveOrderEntry[];
  /** Derived state for interleaved recurring rows, keyed by activity id. */
  recurringStateById?: Record<string, RecurringState>;
}) {
  const [optimistic, applyOptimistic] = useOptimistic(
    tasks,
    (current: Task[], patch: Patch) =>
      current.map((t) =>
        t.id === patch.taskId
          ? {
              ...t,
              ...(patch.status ? { status: patch.status } : {}),
              ...(patch.area ? { area: patch.area } : {}),
            }
          : t,
      ),
  );
  const [, startTransition] = useTransition();
  const [activeTab, setActiveTab] = useState("All");

  function move(taskId: string, status: TaskStatus, from: TaskStatus) {
    if (status === from) return;
    startTransition(async () => {
      applyOptimistic({ taskId, status });
      await updateTaskStatusAction(taskId, status);
    });
  }

  function assignArea(taskId: string, area: string) {
    startTransition(async () => {
      applyOptimistic({ taskId, area });
      await updateTaskAreaAction(taskId, area);
    });
  }

  const areas = useMemo(() => {
    const set = new Set<string>(SEED_AREAS);
    for (const t of optimistic) set.add(t.area);
    return [...set];
  }, [optimistic]);

  const tab = activeTab === "All" || areas.includes(activeTab)
    ? activeTab
    : "All";

  const openByArea = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of optimistic) {
      if (t.status === "done") continue;
      counts.set(t.area, (counts.get(t.area) ?? 0) + 1);
    }
    return counts;
  }, [optimistic]);

  // Dependency awareness: a task whose prerequisites aren't done yet can't
  // actually be started, so it shouldn't be recommended or float to the top.
  const depInfo = useMemo(() => {
    const prereqs = new Map<string, string[]>();
    const dependents = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const list = m.get(k);
      if (list) list.push(v);
      else m.set(k, [v]);
    };
    for (const d of dependencies) {
      push(prereqs, d.task_id, d.depends_on_task_id);
      push(dependents, d.depends_on_task_id, d.task_id);
    }
    const titleById = new Map(optimistic.map((t) => [t.id, t.title]));
    const doneIds = new Set(
      optimistic.filter((t) => t.status === "done").map((t) => t.id),
    );
    // Titles of each open task's prerequisites that aren't done yet.
    const waiting = new Map<string, string[]>();
    for (const t of optimistic) {
      if (t.status === "done") continue;
      const unmet = (prereqs.get(t.id) ?? [])
        .filter((id) => titleById.has(id) && !doneIds.has(id))
        .map((id) => titleById.get(id)!);
      if (unmet.length) waiting.set(t.id, unmet);
    }
    // How many still-open tasks each task would unblock once it's done.
    const unblockCount = new Map<string, number>();
    for (const [id, deps] of dependents) {
      const n = deps.filter(
        (d) => titleById.has(d) && !doneIds.has(d),
      ).length;
      if (n) unblockCount.set(id, n);
    }
    return { waiting, unblockCount };
  }, [optimistic, dependencies]);

  // The global cross-project order, looked up by task id. Deadline pressure can
  // pull one project's task ahead of another's — keyed on id so an optimistically
  // completed task (dropped from `optimistic`) never carries a stale rank.
  const orderByTask = useMemo(
    () => new Map(order.map((e) => [e.taskId, e])),
    [order],
  );

  // Reasons for the tasks deadline pressure pulled ahead — annotated on their
  // rows. Empty for single-project users (nothing leapfrogs anything).
  const pulledAhead = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of order) if (e.pulledAhead) m.set(e.taskId, e.reason);
    return m;
  }, [order]);

  const b = useMemo(() => {
    const isWaiting = (t: Task) => depInfo.waiting.has(t.id);
    // Rank by the global order; fall back to priority_score when a task isn't in
    // the order (empty/not loaded, or filtered out upstream).
    const byGlobalRank = (x: Task, y: Task) => {
      const rx = orderByTask.get(x.id)?.rank ?? Number.POSITIVE_INFINITY;
      const ry = orderByTask.get(y.id)?.rank ?? Number.POSITIVE_INFINITY;
      return rx - ry || byPriority(x, y);
    };
    const visible =
      tab === "All" ? optimistic : optimistic.filter((t) => t.area === tab);
    const open = visible.filter((t) => t.status !== "done");
    const blocked = open
      .filter((t) => t.status === "blocked")
      .sort(byGlobalRank);
    const sorted = open
      .filter((t) => t.status !== "blocked")
      .sort((x, y) => {
        // Ready-to-start tasks rank above ones still waiting on a
        // prerequisite, then ties break on the global order.
        const xw = isWaiting(x) ? 1 : 0;
        const yw = isWaiting(y) ? 1 : 0;
        return xw - yw || byGlobalRank(x, y);
      });
    const overdue = sorted.filter((t) => isOverdue(t.due_date));
    const dueToday = sorted.filter(
      (t) => !isOverdue(t.due_date) && isToday(t.due_date),
    );
    const focus = sorted
      .filter((t) => !isOverdue(t.due_date) && !isToday(t.due_date))
      .slice(0, 6);
    return {
      open,
      blocked,
      actionable: sorted,
      overdue,
      dueToday,
      focus,
      // The next task to do: first startable REAL task in the global order. A
      // recurring routine is never the hero (it has no entry to open); routines
      // still surface in the sections below.
      recommended:
        sorted.find((t) => !isWaiting(t) && !isRecurringTaskId(t.id)) ??
        sorted.find((t) => !isRecurringTaskId(t.id)),
    };
  }, [optimistic, tab, depInfo, orderByTask]);

  const rec = b.recommended;
  const recEntry = rec ? orderByTask.get(rec.id) : undefined;
  const recUnblocks = rec ? depInfo.unblockCount.get(rec.id) ?? 0 : 0;
  const totalOpen = optimistic.filter((t) => t.status !== "done").length;

  return (
    <MotionConfig reducedMotion="user">
      {/* Area tabs */}
      <div className="mb-5 flex flex-wrap gap-1 border-b border-[var(--color-border)] pb-px">
        <TabButton
          label="All"
          count={totalOpen}
          active={tab === "All"}
          onClick={() => setActiveTab("All")}
        />
        {areas.map((a) => (
          <TabButton
            key={a}
            label={a}
            count={openByArea.get(a) ?? 0}
            active={tab === a}
            onClick={() => setActiveTab(a)}
          />
        ))}
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatChip
          icon={ListTodo}
          label="Active tasks"
          value={b.open.length}
          tone="bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
        />
        <StatChip
          icon={Sun}
          label="Due today"
          value={b.dueToday.length}
          tone="bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]"
        />
        <StatChip
          icon={AlertTriangle}
          label="Overdue"
          value={b.overdue.length}
          tone="bg-[var(--color-surface-raised)] text-[var(--color-danger)]"
        />
        <StatChip
          icon={Ban}
          label="Blocked"
          value={b.blocked.length}
          tone="bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]"
        />
      </div>

      {/* Recommended next task */}
      {rec && (
        <div className="mt-5 shimmer-host animate-glow group rounded-md border border-[var(--color-accent-subtle)] bg-[var(--color-accent-subtle)] p-5 transition-shadow duration-200 hover:shadow-md">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)] text-white">
              <Sparkles className="size-4 animate-sparkle" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent-fg)]">
                Recommended next task
              </p>
              <p className="mt-1 text-[15px] font-semibold text-[var(--color-fg)]">
                {rec.title}
              </p>
              {rec.priority_reason && (
                <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]">
                  {rec.priority_reason}
                </p>
              )}
              {recEntry?.pulledAhead && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-accent-fg)]">
                  <ArrowUpCircle className="size-3.5 shrink-0" />
                  {recEntry.reason}
                </p>
              )}
              {recUnblocks > 0 && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-accent-fg)]">
                  <Lock className="size-3.5 shrink-0" />
                  Do this first — {recUnblocks}{" "}
                  {recUnblocks === 1 ? "task" : "tasks"} depend
                  {recUnblocks === 1 ? "s" : ""} on it.
                </p>
              )}
              <div className="mt-2.5 flex items-center gap-2">
                <PriorityBadge
                  label={rec.priority_label}
                  score={rec.priority_score}
                />
                <Link
                  href={`/entries/${rec.entry_id}`}
                  className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-accent-fg)] hover:underline"
                >
                  Open entry
                  <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Agenda */}
      <Card className="mt-5">
        <CardHeader title="Today's agenda" icon={<Sun className="size-4" />} />
        {b.actionable.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={CheckCircle2}
              title={
                tab === "All"
                  ? "Nothing on your plate"
                  : `Nothing in ${tab} yet`
              }
              description={
                tab === "All"
                  ? "No open tasks right now. Create an entry to capture more work."
                  : `Assign a task to ${tab} from its area menu to see it here.`
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            <Section
              label="Overdue"
              icon={AlertTriangle}
              tone="text-[var(--color-danger)]"
              tasks={b.overdue}
              entryTitles={entryTitles}
              areas={areas}
              waiting={depInfo.waiting}
              pulledAhead={pulledAhead}
              recurringStateById={recurringStateById}
              onMove={move}
              onAssignArea={assignArea}
            />
            <Section
              label="Due today"
              icon={Sun}
              tone="text-[var(--color-accent-fg)]"
              tasks={b.dueToday}
              entryTitles={entryTitles}
              areas={areas}
              waiting={depInfo.waiting}
              pulledAhead={pulledAhead}
              recurringStateById={recurringStateById}
              onMove={move}
              onAssignArea={assignArea}
            />
            <Section
              label="Focus"
              icon={Flame}
              tone="text-[var(--color-fg)]"
              tasks={b.focus}
              entryTitles={entryTitles}
              areas={areas}
              waiting={depInfo.waiting}
              pulledAhead={pulledAhead}
              recurringStateById={recurringStateById}
              onMove={move}
              onAssignArea={assignArea}
            />
          </div>
        )}
      </Card>

      {/* Blocked */}
      {b.blocked.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Blocked" icon={<Lock className="size-4" />} />
          <div className="px-3 py-3">
            <motion.div layout className="flex flex-col gap-1.5">
              <AnimatePresence initial={false}>
                {b.blocked.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    entryTitle={entryTitles[t.entry_id]}
                    areas={areas}
                    pulledAheadReason={pulledAhead.get(t.id)}
                    onMove={move}
                    onAssignArea={assignArea}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          </div>
        </Card>
      )}
    </MotionConfig>
  );
}

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
        active
          ? "border-[var(--color-accent)] text-[var(--color-fg)]"
          : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
      )}
    >
      {label}
      <span
        className={cn(
          "flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
          active
            ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent-fg)]"
            : "bg-[var(--color-surface-overlay)] text-[var(--color-fg-muted)]",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function Section({
  label,
  icon: Icon,
  tone,
  tasks,
  entryTitles,
  areas,
  waiting,
  pulledAhead,
  recurringStateById,
  onMove,
  onAssignArea,
}: {
  label: string;
  icon: LucideIcon;
  tone: string;
  tasks: Task[];
  entryTitles: Record<string, string>;
  areas: string[];
  waiting: Map<string, string[]>;
  pulledAhead: Map<string, string>;
  recurringStateById: Record<string, RecurringState>;
  onMove: (id: string, status: TaskStatus, from: TaskStatus) => void;
  onAssignArea: (id: string, area: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="px-3 py-3">
      <p className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.05em]">
        <Icon className={cn("size-3.5", tone)} />
        <span className={tone}>{label}</span>
        <span className="font-normal text-[var(--color-fg-subtle)]">
          {tasks.length}
        </span>
      </p>
      <motion.div layout className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {tasks.map((t) => {
            // A synthetic recurring row renders its own check/skip controls.
            const aid = isRecurringTaskId(t.id)
              ? activityIdFromTaskId(t.id)
              : null;
            const rstate = aid ? recurringStateById[aid] : undefined;
            if (rstate) return <RecurringAgendaRow key={t.id} state={rstate} />;
            return (
              <TaskRow
                key={t.id}
                task={t}
                entryTitle={entryTitles[t.entry_id]}
                areas={areas}
                waitingOn={waiting.get(t.id)}
                pulledAheadReason={pulledAhead.get(t.id)}
                onMove={onMove}
                onAssignArea={onAssignArea}
              />
            );
          })}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function StatChip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 shadow-xs">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          tone,
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[17px] font-bold leading-none tabular-nums text-[var(--color-fg)]">
          {value}
        </p>
        <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">{label}</p>
      </div>
    </div>
  );
}
