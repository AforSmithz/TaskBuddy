"use client";

import { useState, useTransition } from "react";
import { ArrowRight, RefreshCw, RotateCcw, Undo2 } from "lucide-react";
import type { PlanRoll, PlanRollKind, PlanVersion } from "@/lib/types";
import { undoPlanRollAction, undoPlanVersionAction } from "@/lib/actions";
import { formatPct } from "@/components/forecast/forecast-meter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** Compact "2h ago" stamp - history rows don't need the full timestamp. */
function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** One entry in the merged plan timeline: an applied strategy bundle (`undoPlanVersion`
 *  = row restore) or an automatic roll of the committed plan (`undoPlanRoll` = arrangement
 *  restore). Two distinct undo semantics, one time-ordered feed (design §5). */
type TimelineEntry =
  | { type: "apply"; at: string; version: PlanVersion }
  | { type: "roll"; at: string; roll: PlanRoll };

/** Neutral, structural label per roll kind - WHAT changed, not WHY. The causal line
 *  ("Pulled Recital forward to protect its deadline") is S3c-3's `diagnoseRoll`, computed
 *  server-side and passed in as `rollCauses`; this map is the defensive fallback when a
 *  summary is absent. */
const ROLL_LABEL: Record<PlanRollKind, string> = {
  material: "Plan reshuffled",
  anchor: "Rolled forward a day",
  initial: "Initial plan",
};

/** The task a roll's arrangement leads with (lowest rank) - the near horizon in one line.
 *  The stored order is a historical snapshot, shown under a timestamp, so a since-completed
 *  task here is honest record, not a live claim. */
function leadTask(roll: PlanRoll): string | null {
  if (roll.order.length === 0) return null;
  return roll.order.reduce((a, b) => (a.rank <= b.rank ? a : b)).title;
}

function RevertedPill() {
  return (
    <span className="ml-0.5 rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
      Reverted
    </span>
  );
}

/** An applied strategy bundle: the reason, the odds accepted (before → after), moves. */
function ApplyRow({ version: v, reverted }: { version: PlanVersion; reverted: boolean }) {
  const showOdds = Number.isFinite(v.oddsBefore) && Number.isFinite(v.oddsAfter);
  return (
    <>
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
        {reverted && <RevertedPill />}
      </p>
    </>
  );
}

/** An automatic roll of the committed plan: WHY it shifted (the server-diagnosed causal line,
 *  `summary`, falling back to the neutral structural label) and its near-horizon lead. The
 *  leading icon tags it as a roll (vs an apply) without recomputing anything client-side. */
function RollRow({
  roll,
  reverted,
  summary,
}: {
  roll: PlanRoll;
  reverted: boolean;
  summary?: string;
}) {
  const lead = leadTask(roll);
  return (
    <>
      <p
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--color-fg)]",
          reverted && "text-[var(--color-fg-subtle)] line-through",
        )}
      >
        <RefreshCw className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
        <span className="truncate">{summary ?? ROLL_LABEL[roll.kind]}</span>
      </p>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-fg-subtle)]">
        <span className="shrink-0">{relativeTime(roll.rolledAt)}</span>
        {lead && (
          <>
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <span className="truncate">
              leads with{" "}
              <span className="text-[var(--color-fg-muted)]">{lead}</span>
            </span>
          </>
        )}
        {reverted && <RevertedPill />}
      </p>
    </>
  );
}

/**
 * The plan timeline (vision §1.3): every applied strategy bundle AND every automatic
 * roll of the committed plan, unioned into one newest-first feed. Applies carry the odds
 * the user accepted and a whole-bundle Revert; rolls carry their near-horizon lead and a
 * roll-Undo that restores the prior arrangement through reconcile. Reverted entries stay
 * listed (struck through) so the record is complete. Each row drives its own undo verb.
 */
export function PlanHistory({
  versions,
  rolls,
  rollCauses = {},
}: {
  versions: PlanVersion[];
  rolls: PlanRoll[];
  /** Server-diagnosed "why it changed" line per roll id (S3c-3 `diagnoseRoll`). Optional - 
   *  a roll with no entry falls back to the neutral structural label. */
  rollCauses?: Record<string, string>;
}) {
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Merge the two histories (applies keyed by `createdAt`, rolls by `rolledAt`) into one
  // time-ordered feed. Ids are uuids so a single reverting-id tracks either kind's row.
  const entries: TimelineEntry[] = [
    ...versions.map(
      (v): TimelineEntry => ({ type: "apply", at: v.createdAt, version: v }),
    ),
    ...rolls.map((r): TimelineEntry => ({ type: "roll", at: r.rolledAt, roll: r })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  function revert(id: string, action: (id: string) => Promise<void>) {
    setRevertingId(id);
    startTransition(async () => {
      await action(id);
      setRevertingId(null);
    });
  }

  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {entries.map((entry) => {
        const isApply = entry.type === "apply";
        const id = isApply ? entry.version.id : entry.roll.id;
        const reverted =
          (isApply ? entry.version.revertedAt : entry.roll.revertedAt) !== null;
        const action = isApply ? undoPlanVersionAction : undoPlanRollAction;
        return (
          <li
            key={`${entry.type}-${id}`}
            className="flex items-center gap-3 px-5 py-3 first:pt-4 last:pb-4"
          >
            <div className="min-w-0 flex-1">
              {isApply ? (
                <ApplyRow version={entry.version} reverted={reverted} />
              ) : (
                <RollRow
                  roll={entry.roll}
                  reverted={reverted}
                  summary={rollCauses[entry.roll.id]}
                />
              )}
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
                loading={revertingId === id}
                disabled={pending}
                onClick={() => revert(id, action)}
              >
                <Undo2 className="size-3.5" />
                {isApply ? "Revert" : "Undo"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
