"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Quote,
  User,
  CalendarDays,
  Sparkles,
  ChevronDown,
  FolderKanban,
  MoonStar,
} from "lucide-react";
import type { PriorityLabel, Task } from "@/lib/types";
import { PriorityBadge, Pill } from "@/components/ui/badge";
import { formatDate, formatMinutes, isOverdue } from "@/lib/format";
import { cn } from "@/lib/cn";

/** The six 1-5 ratings behind the priority score (normalized names so a stored
 *  Task and a strategist proposal map onto the same breakdown). */
export interface RowFactors {
  urgency: number | null;
  impact: number | null;
  dependency: number | null;
  risk: number | null;
  confidence: number | null;
  effort: number | null;
}

/**
 * The presentational shape one task row needs. A stored `Task` maps onto it via
 * `taskToRowData`, and so do the strategist's proposed (not-yet-real) tasks —
 * everything past `title` is optional, so a sparse proposal renders only what it
 * knows (no priority badge, no due date) while a real task renders in full.
 */
export interface TaskRowData {
  title: string;
  priorityLabel?: PriorityLabel | null;
  priorityScore?: number | null;
  estimatedMinutes?: number | null;
  dueDate?: string | null;
  owner?: string | null;
  category?: string | null;
  isAiSuggested?: boolean;
  sourceQuote?: string | null;
  priorityReason?: string | null;
  blockedBy?: string | null;
  factors?: RowFactors | null;
  /** Which project this task belongs to — shown as a tag in cross-project views. */
  projectName?: string | null;
}

/** Lift a stored task into the row shape — the canonical full-detail mapping. */
export function taskToRowData(t: Task): TaskRowData {
  return {
    title: t.title,
    priorityLabel: t.priority_label,
    priorityScore: t.priority_score,
    estimatedMinutes: t.estimated_minutes,
    dueDate: t.due_date,
    owner: t.owner,
    category: t.category,
    isAiSuggested: t.is_ai_suggested,
    sourceQuote: t.source_quote,
    priorityReason: t.priority_reason,
    blockedBy: t.blocked_by,
    factors: {
      urgency: t.urgency_score,
      impact: t.impact_score,
      dependency: t.dependency_score,
      risk: t.risk_score,
      confidence: t.confidence_score,
      effort: t.effort_score,
    },
  };
}

// Effort is the only factor subtracted from the score, so it is flagged.
const FACTORS: {
  key: keyof RowFactors;
  label: string;
  penalty?: boolean;
}[] = [
  { key: "urgency", label: "Urgency" },
  { key: "impact", label: "Impact" },
  { key: "dependency", label: "Dependency" },
  { key: "risk", label: "Risk" },
  { key: "confidence", label: "Confidence" },
  { key: "effort", label: "Effort", penalty: true },
];

/** Per-factor 1-5 breakdown behind a task's priority score. */
export function FactorBreakdown({ factors }: { factors: RowFactors }) {
  const present = FACTORS.map((f) => ({
    ...f,
    value: factors[f.key],
  })).filter((f) => typeof f.value === "number");

  if (present.length === 0) return null;

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1.5 rounded-sm bg-[var(--color-bg)] px-3 py-2.5 sm:grid-cols-3">
      {present.map((f) => (
        <div key={f.key} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            {f.label}
            {f.penalty && (
              <span
                className="text-[var(--color-fg-subtle)]"
                title="Effort is subtracted from the priority score"
              >
                {" "}
                (penalty)
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className={cn(
                    "size-1 rounded-full",
                    n <= (f.value as number)
                      ? f.penalty
                        ? "bg-[var(--color-fg-subtle)]"
                        : "bg-[var(--color-accent)]"
                      : "bg-[var(--color-border-strong)]",
                  )}
                />
              ))}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
              {f.value}/5
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The presentational task row used on the project page and reused wherever tasks
 * are shown (the strategy card's changed-task disclosures). It owns no mutations:
 * interactive controls (status select, actual-time input) are passed in as
 * `trailing` / `metaTrailing` slots so the same markup serves both a live task
 * and a hypothetical one. `deferred` tags a row as set-aside work (no cross-out).
 */
export function TaskDetailRow({
  data,
  deferred = false,
  defaultBreakdownOpen = false,
  href,
  trailing,
  metaTrailing,
}: {
  data: TaskRowData;
  /** Marks the task as set-aside: shows a "Deferred" tag (no cross-out). */
  deferred?: boolean;
  defaultBreakdownOpen?: boolean;
  /** When set, the title links here (e.g. the task's detail page). */
  href?: string;
  /** Top-right control (e.g. a status select). */
  trailing?: React.ReactNode;
  /** Appended to the meta row (e.g. an actual-time input). */
  metaTrailing?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultBreakdownOpen);
  const hasBreakdown =
    data.factors != null &&
    FACTORS.some((f) => typeof data.factors![f.key] === "number");
  const overdue = !deferred && data.dueDate != null && isOverdue(data.dueDate);
  const hasBadgeRow =
    data.priorityLabel != null ||
    data.projectName != null ||
    deferred ||
    data.isAiSuggested;

  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        {hasBadgeRow && (
          <div className="flex flex-wrap items-center gap-2">
            {data.priorityLabel != null && (
              <PriorityBadge
                label={data.priorityLabel}
                score={data.priorityScore}
              />
            )}
            {data.projectName != null && (
              <Pill className="gap-1">
                <FolderKanban className="size-3" />
                {data.projectName}
              </Pill>
            )}
            {deferred && (
              <Pill className="gap-1 bg-[var(--color-surface-overlay)] text-[var(--color-fg-muted)]">
                <MoonStar className="size-3" />
                Deferred
              </Pill>
            )}
            {data.isAiSuggested && (
              <span className="inline-flex items-center gap-1 rounded-xs bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-fg)]">
                <Sparkles className="size-3" />
                AI suggested
              </span>
            )}
          </div>
        )}
        <p className="mt-1.5 text-[14px] font-medium text-[var(--color-fg)]">
          {href ? (
            <Link
              href={href}
              className="transition-colors hover:text-[var(--color-accent)]"
            >
              {data.title}
            </Link>
          ) : (
            data.title
          )}
        </p>
        {data.sourceQuote && (
          <p className="mt-1 flex items-start gap-1.5 text-[12px] italic text-[var(--color-fg-subtle)]">
            <Quote className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-2">{data.sourceQuote}</span>
          </p>
        )}
        {data.priorityReason && (
          <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
            {data.priorityReason}
          </p>
        )}
        {hasBreakdown && (
          <>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
            >
              <ChevronDown
                className={cn("size-3 transition-transform", open && "rotate-180")}
              />
              Score breakdown
            </button>
            {open && <FactorBreakdown factors={data.factors!} />}
          </>
        )}
        {data.blockedBy && (
          <p className="mt-1 text-[12px] text-[var(--color-status-blocked-fg)]">
            Blocked by: {data.blockedBy}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--color-fg-muted)]">
          {data.owner && (
            <span className="flex items-center gap-1.5">
              <User className="size-3.5" />
              {data.owner}
            </span>
          )}
          {data.category && (
            <span className="text-[var(--color-fg-subtle)]">
              {data.category}
            </span>
          )}
          {data.dueDate != null && (
            <span
              className={cn(
                "flex items-center gap-1.5",
                overdue && "text-[var(--color-danger)]",
              )}
            >
              <CalendarDays className="size-3.5" />
              {formatDate(data.dueDate)}
            </span>
          )}
          {typeof data.estimatedMinutes === "number" && (
            <span className="font-mono text-[var(--color-fg-subtle)]">
              est {formatMinutes(data.estimatedMinutes)}
            </span>
          )}
          {metaTrailing}
        </div>
      </div>

      {trailing}
    </div>
  );
}
