"use client";

import { useState, useTransition } from "react";
import { ArrowRight, RotateCcw, Undo2 } from "lucide-react";
import type { PlanVersion } from "@/lib/types";
import { undoPlanVersionAction } from "@/lib/actions";
import { formatPct } from "@/components/forecast/forecast-meter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** Compact "2h ago" stamp — history rows don't need the full timestamp. */
function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * The plan version history (vision §1.3): every applied strategy bundle, newest
 * first, with the odds the user accepted (before → after) and a whole-bundle Revert
 * — undo restores the snapshot in one shot (§8.2). A reverted bundle stays listed
 * (struck through) so the record is complete. Server-rendered list; revert is the
 * only interaction, so each row drives `undoPlanVersionAction` through a transition.
 */
export function PlanHistory({ versions }: { versions: PlanVersion[] }) {
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function revert(id: string) {
    setRevertingId(id);
    startTransition(async () => {
      await undoPlanVersionAction(id);
      setRevertingId(null);
    });
  }

  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {versions.map((v) => {
        const reverted = v.revertedAt !== null;
        const showOdds =
          Number.isFinite(v.oddsBefore) && Number.isFinite(v.oddsAfter);
        return (
          <li
            key={v.id}
            className="flex items-center gap-3 px-5 py-3 first:pt-4 last:pb-4"
          >
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate text-[13px] text-[var(--color-fg)]",
                  reverted && "text-[var(--color-fg-subtle)] line-through",
                )}
              >
                {v.reason}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-fg-subtle)]">
                <span>{relativeTime(v.createdAt)}</span>
                <span aria-hidden>·</span>
                <span>
                  {v.moves.length} move{v.moves.length > 1 ? "s" : ""}
                </span>
                {showOdds && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      {formatPct(v.oddsBefore)}
                      <ArrowRight className="size-3" />
                      {formatPct(v.oddsAfter)}
                    </span>
                  </>
                )}
                {reverted && (
                  <span className="ml-0.5 rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                    Reverted
                  </span>
                )}
              </p>
            </div>
            {reverted ? (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-fg-subtle)]">
                <RotateCcw className="size-3.5" />
                Undone
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                loading={revertingId === v.id}
                disabled={pending}
                onClick={() => revert(v.id)}
              >
                <Undo2 className="size-3.5" />
                Revert
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
