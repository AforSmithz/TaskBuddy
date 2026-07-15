"use client";

import { useState } from "react";
import Link from "next/link";
import { ListChecks, ChevronRight } from "lucide-react";
import { type GoalKind } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { GoalKindBadge } from "@/components/goals/goal-kind-badge";
import { cn } from "@/lib/cn";

export interface GoalCard {
  id: string;
  name: string;
  description: string | null;
  kind: GoalKind;
  entryCount: number;
  open: number;
  total: number;
}

type Filter = "all" | GoalKind;

/**
 * The goals list with a kind filter (All / Projects / Learning). The filter is
 * shown only when goals span both kinds - with one flavour there's nothing to
 * filter, so we keep the list clean.
 */
export function GoalsGrid({ goals }: { goals: GoalCard[] }) {
  const [filter, setFilter] = useState<Filter>("all");

  const projectCount = goals.filter((g) => g.kind === "project").length;
  const learningCount = goals.filter((g) => g.kind === "learning").length;
  const showFilter = projectCount > 0 && learningCount > 0;

  const visible = goals.filter((g) => filter === "all" || g.kind === filter);

  const tabs: { value: Filter; label: string; count: number }[] = [
    { value: "all", label: "All", count: goals.length },
    { value: "project", label: "Projects", count: projectCount },
    { value: "learning", label: "Learning", count: learningCount },
  ];

  return (
    <div>
      {showFilter && (
        <div className="mb-4 inline-flex items-center gap-1 rounded-[14px] bg-[var(--color-surface-overlay)] p-1">
          {tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setFilter(t.value)}
              className={cn(
                "rounded-[10px] px-3 py-1.5 text-[13px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
                filter === t.value
                  ? "bg-[var(--color-surface-raised)] text-[var(--color-fg)] shadow-sm"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              {t.label}
              <span className="ml-1.5 text-[var(--color-fg-subtle)]">
                {t.count}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visible.map((g) => (
          <Link key={g.id} href={`/projects/${g.id}`}>
            <Card className="group h-full p-5 transition-colors hover:border-[var(--color-border-strong)]">
              <div className="flex items-start justify-between gap-3">
                <GoalKindBadge kind={g.kind} />
                <ChevronRight className="size-4 text-[var(--color-fg-subtle)] transition-transform group-hover:translate-x-0.5" />
              </div>
              <p className="mt-3 text-[15px] font-semibold text-[var(--color-fg)]">
                {g.name}
              </p>
              {g.description && (
                <p className="mt-0.5 line-clamp-2 text-[13px] text-[var(--color-fg-muted)]">
                  {g.description}
                </p>
              )}
              <div className="mt-3 flex items-center gap-4 text-[12px] text-[var(--color-fg-muted)]">
                <span>
                  {g.entryCount} {g.entryCount === 1 ? "entry" : "entries"}
                </span>
                <span className="flex items-center gap-1.5">
                  <ListChecks className="size-3.5" />
                  {g.open}/{g.total} open
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
