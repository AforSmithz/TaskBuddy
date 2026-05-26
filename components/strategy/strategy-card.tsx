"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  Check,
  Compass,
  Lock,
  RefreshCw,
  Route,
  Scissors,
  Shield,
  Sparkles,
  TrafficCone,
} from "lucide-react";
import type {
  PortfolioStrategy,
  StrategyMove,
  StrategyMoveKind,
  StrategyMovePayload,
} from "@/lib/types";
import {
  acceptRecoveryTasksAction,
  applyModificationsAction,
  applyRerouteAction,
  applyTriageAction,
  deferTaskAction,
  refreshPortfolioStrategyAction,
  rescheduleTaskAction,
  setProjectDeadlineAction,
  unblockTaskAction,
  updateTaskStatusAction,
} from "@/lib/actions";
import { band, formatPct } from "@/components/forecast/forecast-meter";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

function toneText(p: number): string {
  const b = band(p);
  return b === "off"
    ? "text-[var(--color-danger)]"
    : b === "risk"
      ? "text-[var(--color-accent-fg)]"
      : "text-[var(--color-status-done)]";
}

/** Icon per move kind — mirrors the visual language of the recovery callout. */
const MOVE_ICON: Record<StrategyMoveKind, typeof ArrowRight> = {
  defer: ArrowRight,
  reschedule_deadline: CalendarClock,
  reschedule_task: CalendarClock,
  unblock: Lock,
  mark_done: Check,
  triage: TrafficCone,
  add_tasks: Sparkles,
  reshape: Scissors,
  reroute: Route,
  hold: Shield,
};

/** Run a move through its mapped apply action. The probability never moves here. */
function applyMove(payload: StrategyMovePayload, projectId: string): Promise<unknown> {
  switch (payload.kind) {
    case "defer":
      return deferTaskAction(payload.taskId, true);
    case "reschedule_deadline":
      return setProjectDeadlineAction(projectId, payload.deadline);
    case "reschedule_task":
      return rescheduleTaskAction(payload.taskId, payload.dueDate);
    case "unblock":
      return unblockTaskAction(payload.taskId);
    case "mark_done":
      return updateTaskStatusAction(payload.taskId, "done");
    case "triage":
      return applyTriageAction(payload.taskIds);
    case "add_tasks":
      return acceptRecoveryTasksAction(projectId, payload.tasks);
    case "reshape":
      return applyModificationsAction(projectId, payload.mods);
    case "reroute":
      return applyRerouteAction(
        projectId,
        payload.replacedTaskIds,
        payload.tasks,
      );
    case "hold":
      return Promise.resolve();
  }
}

/** Deadline-moving reschedules go last so deferrals free their hours first. */
function applyOrder(a: StrategyMove, b: StrategyMove): number {
  const last = (k: StrategyMoveKind) => (k === "reschedule_deadline" ? 1 : 0);
  return last(a.kind) - last(b.kind);
}

/**
 * The Today page's single portfolio recommendation. Replaces the old pit-wall +
 * "Needs attention" stack with one AI-synthesized strategy: a narrative
 * assessment plus ordered, inline-applyable moves spanning every project.
 *
 * Regeneration is gated deterministically (the server only marks `stale` when the
 * odds moved materially or the strategy aged out — a cosmetic edit never does).
 * When the LLM is available (`canUseLLM`), the card auto-regenerates in the
 * background — on first load it upgrades the deterministic draft, and a stale
 * strategy refreshes itself — so the AI strategy stays current without a click.
 * "Am I on track?" / the stale banner's Refresh remain as manual triggers.
 */
export function StrategyCard({
  strategy,
  stale,
  canUseLLM,
}: {
  strategy: PortfolioStrategy;
  stale: boolean;
  canUseLLM: boolean;
}) {
  // The freshly refreshed strategy wins over the server-passed one until the
  // next server render catches up (revalidatePath fires inside the action).
  const [refreshed, setRefreshed] = useState<PortfolioStrategy | null>(null);
  const current = refreshed ?? strategy;
  const isStale = stale && refreshed === null;

  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [pending, startTransition] = useTransition();
  const [refreshing, startRefresh] = useTransition();

  function refresh() {
    startRefresh(async () => {
      const next = await refreshPortfolioStrategyAction();
      setRefreshed(next);
      setApplied(new Set());
    });
  }

  // Aggressive policy: when the LLM is available, regenerate in the background —
  // upgrade a deterministic draft on first load, or refresh a stale strategy —
  // exactly once per mount. The server's deterministic gate already ensures
  // `stale` only fires on a material change, so this never spins on cosmetic edits.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoFired.current || !canUseLLM || refreshed) return;
    if (strategy.usedLLM && !stale) return; // already a fresh AI strategy
    autoFired.current = true;
    startRefresh(async () => {
      const next = await refreshPortfolioStrategyAction();
      setRefreshed(next);
      setApplied(new Set());
    });
  }, [canUseLLM, refreshed, stale, strategy.usedLLM, startRefresh]);

  function applyOne(index: number, move: StrategyMove) {
    setBusy(index);
    startTransition(async () => {
      await applyMove(move.payload, move.projectId);
      setApplied((s) => new Set(s).add(index));
      setBusy(null);
    });
  }

  function applyAll() {
    setBusy("all");
    startTransition(async () => {
      const ordered = current.moves
        .map((move, index) => ({ move, index }))
        .filter(({ index }) => !applied.has(index))
        .sort((a, b) => applyOrder(a.move, b.move));
      // Sequential — a deadline reschedule must see the deferrals' freed hours.
      for (const { move } of ordered) {
        await applyMove(move.payload, move.projectId);
      }
      setApplied(new Set(current.moves.map((_, i) => i)));
      setBusy(null);
    });
  }

  const remaining = current.moves
    .map((move, index) => ({ move, index }))
    .filter(({ index }) => !applied.has(index));
  const calm = current.onTrack || current.moves.length === 0;
  const primaryLabel = current.usedLLM ? "Am I on track?" : "Get AI strategy";

  return (
    <Card>
      <CardHeader
        title="Your strategy"
        icon={<Compass className="size-4 text-[var(--color-accent)]" />}
        action={
          !current.usedLLM ? (
            <span
              title="A deterministic draft — generate the AI strategy for a synthesized recommendation."
              className="shrink-0 rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]"
            >
              Draft
            </span>
          ) : undefined
        }
      />
      <div className="p-4">
        {/* Background regeneration in flight — auto (first-load upgrade / stale
            refresh) or a manual click. */}
        {refreshing ? (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3.5 py-2.5">
            <RefreshCw className="size-3.5 shrink-0 animate-spin text-[var(--color-accent-fg)]" />
            <p className="min-w-0 text-[12px] text-[var(--color-fg-muted)]">
              Synthesizing your strategy…
            </p>
          </div>
        ) : isStale ? (
          /* Stale and not auto-refreshing (e.g. LLM offline) — offer a manual refresh. */
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] border-l-2 border-l-[var(--color-accent)] bg-[var(--color-surface-raised)] px-3.5 py-2.5">
            <p className="min-w-0 text-[12px] text-[var(--color-fg-muted)]">
              Your situation changed since this strategy — refresh for current
              advice.
            </p>
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </div>
        ) : null}

        {/* Assessment narrative */}
        <p className="px-1 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
          {current.assessment}
        </p>

        {/* Moves — best-first, each applyable inline. */}
        {remaining.length > 0 && (
          <div className="mt-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                Recommended moves
              </p>
              {remaining.length > 1 && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === "all"}
                  disabled={pending}
                  onClick={applyAll}
                >
                  Apply all {remaining.length}
                </Button>
              )}
            </div>
            <div className="mt-1.5 space-y-1.5">
              {remaining.map(({ move, index }) => {
                const Icon = MOVE_ICON[move.kind];
                return (
                  <div
                    key={index}
                    className="flex items-center gap-2 rounded-md bg-[var(--color-surface-raised)] px-2.5 py-2"
                  >
                    <Icon className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
                    <span className="min-w-0 flex-1 text-[12px] text-[var(--color-fg-muted)]">
                      {move.rationale}
                    </span>
                    {move.kind !== "hold" && (
                      <span
                        className={cn(
                          "shrink-0 text-[12px] font-semibold tabular-nums",
                          toneText(move.probabilityAfter),
                        )}
                      >
                        → {formatPct(move.probabilityAfter)}
                      </span>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === index}
                      disabled={pending}
                      onClick={() => applyOne(index, move)}
                    >
                      Apply
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Calm — held course, or every move applied. */}
        {calm && remaining.length === 0 && (
          <p className="mt-3 flex items-center gap-1.5 px-1 text-[12px] text-[var(--color-status-done)]">
            <Shield className="size-3.5 shrink-0" />
            {current.onTrack
              ? "On track — nothing to change right now."
              : "All recommended moves applied — forecast updating."}
          </p>
        )}

        {/* Footer — the only LLM trigger + the link to the full detail. */}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
          <Button
            variant="ghost"
            size="sm"
            loading={refreshing}
            onClick={refresh}
          >
            <RefreshCw className="size-3.5" />
            {primaryLabel}
          </Button>
          <Link
            href="/strategy"
            className="flex items-center gap-1 text-[12px] font-medium text-[var(--color-accent-fg)] transition-colors hover:text-[var(--color-accent)]"
          >
            Details
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </div>
    </Card>
  );
}
