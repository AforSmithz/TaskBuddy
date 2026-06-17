"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  Check,
  ChevronDown,
  Lock,
  RefreshCw,
  Repeat,
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
  skipActivityForWeekAction,
  unblockTaskAction,
  updateTaskStatusAction,
} from "@/lib/actions";
import { band, formatPct } from "@/components/forecast/forecast-meter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  TaskDetailRow,
  taskToRowData,
  type TaskRowData,
} from "@/components/entries/task-detail-row";
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
  skip_activity: Repeat,
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
    case "skip_activity":
      return skipActivityForWeekAction(payload.activityId);
    case "hold":
      return Promise.resolve();
  }
}

/** Deadline-moving reschedules go last so deferrals free their hours first. */
function applyOrder(a: StrategyMove, b: StrategyMove): number {
  const last = (k: StrategyMoveKind) => (k === "reschedule_deadline" ? 1 : 0);
  return last(a.kind) - last(b.kind);
}

/** A strategist proposal (a reroute/add part, or a split step) → the shared row
 *  shape. Proposals carry the 1-5 factor ratings but no computed priority score,
 *  so the row shows their breakdown/estimate without a priority badge. */
function partToRowData(p: {
  title: string;
  estimated_minutes: number;
  due_date?: string | null;
  priority_reason?: string;
  urgency: number;
  impact: number;
  dependency: number;
  risk: number;
  effort: number;
  confidence: number;
}): TaskRowData {
  return {
    title: p.title,
    estimatedMinutes: p.estimated_minutes,
    dueDate: p.due_date ?? null,
    priorityReason: p.priority_reason ?? null,
    isAiSuggested: true,
    factors: {
      urgency: p.urgency,
      impact: p.impact,
      dependency: p.dependency,
      risk: p.risk,
      confidence: p.confidence,
      effort: p.effort,
    },
  };
}

/** NET-NEW tasks a move injects (the lighter plan that replaces the deferred
 *  work). A scope_down rewrites in place, so it isn't "added" here. */
function addedTasks(payload: StrategyMovePayload): TaskRowData[] {
  switch (payload.kind) {
    case "reroute":
    case "add_tasks":
      return payload.tasks.map(partToRowData);
    case "reshape":
      return payload.mods.flatMap((m) =>
        m.kind === "split" ? m.replacements.map(partToRowData) : [],
      );
    default:
      return [];
  }
}

/** A labelled group of changed-task rows inside the disclosure — deferred work
 *  carries a "Deferred" tag, net-new work reads as live. Renders the same detailed
 *  task row used on the project page so the trade-off is fully legible. */
function ChangeGroup({
  label,
  items,
  deferred,
}: {
  label: string;
  items: TaskRowData[];
  deferred?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <ul className="mt-1 space-y-1.5">
        {items.map((item, i) => (
          <li
            key={i}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
          >
            <TaskDetailRow data={item} deferred={deferred} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One move row: rationale + its own odds (`→`) and the running portfolio
 * conjunction (`all`), the inline Apply, and — when the move sheds/replaces real
 * work — an expandable disclosure listing EVERY task it changes (deferred and
 * net-new), so the full trade-off is inspectable before applying.
 */
function MoveRow({
  move,
  busy,
  pending,
  onApply,
  projectNames,
}: {
  move: StrategyMove;
  busy: boolean;
  pending: boolean;
  onApply: () => void;
  /** taskId → project name, for tagging deferred tasks (esp. cross-project triage). */
  projectNames: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const Icon = MOVE_ICON[move.kind];
  // Primary = the move's OWN odds; secondary "all" = the running portfolio
  // conjunction after this step (shown so a move that helps its project but
  // leaves the portfolio gated by another deadline doesn't read as "→ 0%").
  const solo = move.probabilityAfter;
  const joint = move.portfolioProbabilityAfter;
  const showAll = Number.isFinite(joint) && formatPct(joint) !== formatPct(solo);

  // Defers can span projects (cross-project triage), so each row resolves its own
  // project by task id; the lighter plan's added tasks all belong to this move's
  // single project.
  const defers = (move.defers ?? []).map((t) => ({
    ...taskToRowData(t),
    projectName: projectNames[t.id] ?? null,
  }));
  const adds = addedTasks(move.payload).map((a) => ({
    ...a,
    projectName: move.projectName || null,
  }));
  const changeCount = defers.length + adds.length;
  const summary =
    defers.length && adds.length
      ? `${changeCount} task changes`
      : defers.length
        ? `Defers ${defers.length} task${defers.length > 1 ? "s" : ""}`
        : `Adds ${adds.length} task${adds.length > 1 ? "s" : ""}`;

  return (
    <div className="rounded-md bg-[var(--color-surface-raised)] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
        <p className="min-w-0 flex-1 text-[12px] text-[var(--color-fg-muted)]">
          {move.rationale}
        </p>
        {move.kind !== "hold" && (
          <div className="flex shrink-0 flex-col items-end leading-tight">
            <span
              className={cn(
                "text-[12px] font-semibold tabular-nums",
                toneText(solo),
              )}
            >
              → {formatPct(solo)}
            </span>
            {showAll && (
              <span className="text-[10px] tabular-nums text-[var(--color-fg-subtle)]">
                all {formatPct(joint)}
              </span>
            )}
          </div>
        )}
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={pending}
          onClick={onApply}
        >
          Apply
        </Button>
      </div>

      {changeCount > 0 && (
        <div className="mt-1 pl-5">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex items-center gap-1 text-[10px] text-[var(--color-fg-subtle)] transition-colors hover:text-[var(--color-fg-muted)]"
          >
            <ChevronDown
              className={cn("size-3 transition-transform", open ? "" : "-rotate-90")}
            />
            {summary}
          </button>
          {open && (
            <div className="mt-1.5 space-y-2">
              <ChangeGroup label="Defer" items={defers} deferred />
              <ChangeGroup label="Add" items={adds} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One applyable tier of moves — the bold "Recommended" plan or the grounded
 * "Steady plan". Each row shows the CUMULATIVE portfolio odds after applying that
 * step (`portfolioProbabilityAfter`), climbing to `combinedProbability` at the
 * "Apply all" (or a plan-level "Together →" line for a single-step plan). Owns its
 * own apply/busy state so the two tiers apply independently; the parent remounts
 * it (via `key`) on every refresh so applied state resets with a new strategy.
 */
function MoveTier({
  moves,
  combinedProbability,
  label,
  projectNames,
  collapsible = false,
  defaultOpen = true,
}: {
  moves: StrategyMove[];
  combinedProbability: number;
  label: string;
  projectNames: Record<string, string>;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(defaultOpen);

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
      const ordered = moves
        .map((move, index) => ({ move, index }))
        .filter(({ index }) => !applied.has(index))
        .sort((a, b) => applyOrder(a.move, b.move));
      // Sequential — a deadline reschedule must see the deferrals' freed hours.
      for (const { move } of ordered) {
        await applyMove(move.payload, move.projectId);
      }
      setApplied(new Set(moves.map((_, i) => i)));
      setBusy(null);
    });
  }

  if (moves.length === 0) return null;

  const remaining = moves
    .map((move, index) => ({ move, index }))
    .filter(({ index }) => !applied.has(index));

  // A strategy cached before Phase 5 has no cumulative odds — fall back to the
  // move's solo odds for rows, and hide the combined chip when it isn't finite,
  // so a stale-schema cache degrades gracefully instead of showing "NaN%".
  const showCombined = Number.isFinite(combinedProbability);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
        className={cn(
          "flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]",
          collapsible && "transition-colors hover:text-[var(--color-fg-muted)]",
        )}
        aria-expanded={collapsible ? open : undefined}
      >
        {collapsible && (
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              open ? "" : "-rotate-90",
            )}
          />
        )}
        {label}
        {collapsible && !open && remaining.length > 0 && (
          <span className="text-[var(--color-fg-subtle)]/70 normal-case tracking-normal">
            ({remaining.length})
          </span>
        )}
      </button>
      {open && remaining.length > 1 && (
        <div className="flex items-center gap-2">
          {showCombined && (
            <span
              className={cn(
                "text-[12px] font-semibold tabular-nums",
                toneText(combinedProbability),
              )}
              title="Portfolio odds that every deadlined project lands once all these moves are applied."
            >
              all → {formatPct(combinedProbability)}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            loading={busy === "all"}
            disabled={pending}
            onClick={applyAll}
          >
            Apply all {remaining.length}
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="mt-3.5">
      {header}
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {remaining.length === 0 ? (
            <p className="flex items-center gap-1.5 px-1 text-[12px] text-[var(--color-status-done)]">
              <Shield className="size-3.5 shrink-0" />
              All moves applied — forecast updating.
            </p>
          ) : (
            remaining.map(({ move, index }) => (
              <MoveRow
                key={index}
                move={move}
                busy={busy === index}
                pending={pending}
                onApply={() => applyOne(index, move)}
                projectNames={projectNames}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Today page's single portfolio recommendation. Replaces the old pit-wall +
 * "Needs attention" stack with one AI-synthesized strategy: a narrative
 * assessment plus ordered, inline-applyable moves spanning every project. The
 * bold tier is the LLM's pick (re-scored jointly so each step shows the running
 * portfolio odds); the optional grounded "Steady plan" tier is the joint
 * optimizer's mechanical-only plan, collapsible so Today stays calm.
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
  projectNames = {},
  steadyPlanDefaultOpen = false,
  severity = "gentle",
}: {
  strategy: PortfolioStrategy;
  stale: boolean;
  canUseLLM: boolean;
  /** taskId → project name, so deferred tasks can show which project they're from. */
  projectNames?: Record<string, string>;
  /** Expand the grounded "Steady plan" tier by default (true on /strategy). */
  steadyPlanDefaultOpen?: boolean;
  /**
   * How loud the banner reads: "gentle" by default (calm front door); "escalated"
   * only when a hard deadline is genuinely at risk — then the card takes a danger
   * accent so a true emergency doesn't read like a minor slip.
   */
  severity?: "gentle" | "escalated";
}) {
  // The freshly refreshed strategy wins over the server-passed one until the
  // next server render catches up (revalidatePath fires inside the action).
  const [refreshed, setRefreshed] = useState<PortfolioStrategy | null>(null);
  const current = refreshed ?? strategy;
  const isStale = stale && refreshed === null;

  const [refreshing, startRefresh] = useTransition();

  function refresh() {
    startRefresh(async () => {
      const next = await refreshPortfolioStrategyAction();
      setRefreshed(next);
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
    });
  }, [canUseLLM, refreshed, stale, strategy.usedLLM, startRefresh]);

  const calm = current.onTrack || current.moves.length === 0;
  const primaryLabel = current.usedLLM ? "Am I on track?" : "Get AI strategy";
  // Remount the tiers when the strategy changes so applied state resets.
  const tierKey = `${current.generatedAt}:${current.usedLLM}`;

  // Escalate visually only for a real emergency (a hard deadline at risk). Never
  // surface raw odds here — the accent is the only louder signal.
  const escalated = severity === "escalated" && !calm;

  // Hero anchor — the giant portfolio number: odds everything lands with this
  // plan (`combinedProbability`). Neutral when healthy; takes the cut/danger tone
  // only when at risk, so an on-track portfolio reads calm. Falls back to a
  // wordmark for a pre-Phase-5 cache that has no combined odds.
  const pct = current.combinedProbability;
  const hasPct = Number.isFinite(pct);
  const heroBand = hasPct ? band(pct) : "track";
  const heroTone =
    heroBand === "off"
      ? "text-[var(--color-danger)]"
      : heroBand === "risk"
        ? "text-[var(--color-cut)]"
        : "text-[var(--color-fg)]";
  const eyebrow = current.usedLLM ? "Recommended strategy" : "Strategy draft";
  const heroCaption = calm
    ? "you're on track right now"
    : "chance everything lands with this plan";
  const headline = escalated
    ? "A deadline needs your attention"
    : calm
      ? "You're on track"
      : "Here's how to keep everything on track";

  return (
    <Card
      className={cn(
        "rounded-[22px] shadow-[var(--shadow-md)]",
        escalated && "border-l-2 border-l-[var(--color-danger)]",
      )}
    >
      <div className="p-6 md:p-7">
        {/* Background regeneration in flight — auto (first-load upgrade / stale
            refresh) or a manual click. */}
        {refreshing ? (
          <div className="mb-5 flex items-center gap-2 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3.5 py-2.5">
            <RefreshCw className="size-3.5 shrink-0 animate-spin text-[var(--color-accent-fg)]" />
            <p className="min-w-0 text-[12px] text-[var(--color-fg-muted)]">
              Synthesizing your strategy…
            </p>
          </div>
        ) : isStale ? (
          /* Stale and not auto-refreshing (e.g. LLM offline) — offer a manual refresh. */
          <div className="mb-5 flex items-center justify-between gap-3 rounded-[14px] border border-[var(--color-border)] border-l-2 border-l-[var(--color-accent)] bg-[var(--color-surface-raised)] px-3.5 py-2.5">
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

        {/* Hero — the giant odds anchor plus the headline & why. */}
        <div className="relative flex flex-col gap-6 overflow-hidden md:flex-row md:gap-8">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-16 -top-20 size-60 rounded-full bg-[image:var(--gradient-brand)] opacity-[0.16] blur-[70px]"
          />
          <div className="relative shrink-0">
            <div className="flex items-center gap-2">
              <p className="text-[12.5px] font-semibold text-[var(--color-fg-subtle)]">
                {eyebrow}
              </p>
              {!current.usedLLM && (
                <span
                  title="A deterministic draft — generate the AI strategy for a synthesized recommendation."
                  className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]"
                >
                  Draft
                </span>
              )}
            </div>
            {hasPct ? (
              <div
                className={cn(
                  "mt-2.5 text-[74px] font-extrabold leading-[0.9] tracking-[-0.04em] tabular-nums",
                  heroTone,
                )}
              >
                {Math.round(pct * 100)}
                <span className="align-top text-[32px] font-bold text-[var(--color-fg-muted)]">
                  %
                </span>
              </div>
            ) : (
              <div className="mt-2.5 text-[40px] font-extrabold leading-tight tracking-[-0.03em] text-[var(--color-fg)]">
                Strategy
              </div>
            )}
            <p className="mt-2 max-w-[160px] text-[13.5px] font-medium text-[var(--color-fg-muted)]">
              {heroCaption}
            </p>
          </div>
          <div className="flex-1 md:border-l md:border-[var(--color-border)] md:pl-8">
            <h1 className="text-[22px] font-bold leading-tight tracking-[-0.02em] text-[var(--color-fg)]">
              {headline}
            </h1>
            <p className="mt-2.5 max-w-[54ch] text-[14px] leading-relaxed text-[var(--color-fg-muted)]">
              {current.assessment}
            </p>
          </div>
        </div>

        {/* Bold tier — the LLM's recommendation, re-scored jointly. */}
        <MoveTier
          key={`bold:${tierKey}`}
          moves={current.moves}
          combinedProbability={current.combinedProbability}
          label="Recommended moves"
          projectNames={projectNames}
        />

        {/* Grounded tier — mechanical-only joint plan, collapsible. */}
        {current.grounded && current.grounded.moves.length > 0 && (
          <MoveTier
            key={`steady:${tierKey}`}
            moves={current.grounded.moves}
            combinedProbability={current.grounded.combinedProbability}
            label="Steady plan"
            projectNames={projectNames}
            collapsible
            defaultOpen={steadyPlanDefaultOpen}
          />
        )}

        {/* Calm — held course, or nothing to act on. */}
        {calm && (
          <p className="mt-3 flex items-center gap-1.5 px-1 text-[12px] text-[var(--color-status-done)]">
            <Shield className="size-3.5 shrink-0" />
            Nothing to change right now — hold course.
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
