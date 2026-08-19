"use client";

import { useTransition } from "react";
import { FolderKanban, GraduationCap } from "lucide-react";
import { GOAL_KIND_LABELS, type GoalKind } from "@/lib/types";
import { setGoalKindAction } from "@/lib/actions";
import { cn } from "@/lib/cn";

const KIND_ICON: Record<GoalKind, typeof FolderKanban> = {
  project: FolderKanban,
  learning: GraduationCap,
};

const KIND_STYLE: Record<GoalKind, string> = {
  project: "bg-[var(--color-surface-overlay)] text-[var(--color-fg-muted)]",
  learning: "bg-[var(--color-accent-subtle)] text-[var(--color-accent-fg)]",
};

export function GoalKindBadge({
  kind,
  className,
}: {
  kind: GoalKind;
  className?: string;
}) {
  const Icon = KIND_ICON[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 h-5 px-1.5 rounded-xs text-[11px] font-semibold uppercase tracking-[0.04em]",
        KIND_STYLE[kind],
        className,
      )}
    >
      <Icon className="size-3" />
      {GOAL_KIND_LABELS[kind]}
    </span>
  );
}

/**
 * The kind badge made editable: a small inline `<select>` that flips a goal
 * between project and learning. Mirrors the DeadlineEditor pattern - a thin
 * client wrapper over the server action, optimistic-free (revalidates on save).
 */
export function GoalKindEditor({
  goalId,
  kind,
}: {
  goalId: string;
  kind: GoalKind;
}) {
  const [pending, startTransition] = useTransition();
  const Icon = KIND_ICON[kind];

  return (
    <label
      className={cn(
        "relative inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-md cursor-pointer",
        "text-[12px] font-semibold transition-colors",
        KIND_STYLE[kind],
        pending && "opacity-60",
      )}
    >
      <Icon className="size-3.5" />
      {GOAL_KIND_LABELS[kind]}
      <select
        aria-label="Goal kind"
        value={kind}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as GoalKind;
          if (next === kind) return;
          startTransition(() => setGoalKindAction(goalId, next));
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="project">{GOAL_KIND_LABELS.project}</option>
        <option value="learning">{GOAL_KIND_LABELS.learning}</option>
      </select>
    </label>
  );
}
