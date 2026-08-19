"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  ArrowRight,
  Check,
  Flag,
  Scale,
  Shield,
  TrafficCone,
  Undo2,
} from "lucide-react";
import type { PitWall } from "@/lib/store";
import type { PitWallOption } from "@/lib/types";
import {
  applyTriageAction,
  setAutoStrategyAction,
  undoTriageAction,
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

/** The pit wall: the bird's-eye view of what the shared hours can't satisfy and the
 *  cross-project trade-off to make. Always mounted on Today - when nothing collides it shows a
 *  calm one-liner, so its automation toggle stays reachable. Two conflict paths: an auto recovery
 *  (shed the lowest-value doomed work) and, only on a genuine comparable-value tie, an escalation
 *  where the user picks which project to protect. Every move reuses the reversible defer.
 *
 *  `autoStrategy` on = the auto path applies itself on sight and leaves an undoable receipt here;
 *  off = each move is surfaced for one click. A tie always stays the user's call - auto escalates
 *  ties, it never resolves them. */
export function PitWallCallout({
  pitWall,
  autoStrategy,
}: {
  pitWall: PitWall;
  autoStrategy: boolean;
}) {
  const { conflicts, triage, needsDecision, options } = pitWall;
  const collision = conflicts.some((c) => c.kind === "deadline_collision");
  const hasConflict = conflicts.length > 0;

  // Receipt of an auto-applied batch, kept across the revalidation that clears
  // the conflict (the inner panels unmount once `triage` empties; this card
  // doesn't, so the receipt lives here). Null until auto has shed something.
  const [receipt, setReceipt] = useState<{ taskIds: string[] } | null>(null);
  const [pending, startTransition] = useTransition();
  const [undoing, setUndoing] = useState(false);

  // The auto/manual mode, optimistic so the switch and its description update
  // together the instant it's flipped (the server pref catches up on revalidate).
  const [autoOn, setAutoOn] = useState(autoStrategy);
  const [, startStrategy] = useTransition();
  function toggleStrategy() {
    const next = !autoOn;
    setAutoOn(next);
    startStrategy(async () => {
      await setAutoStrategyAction(next);
    });
  }
  const modeDescription = autoOn
    ? "Auto-defers obvious low-value work to protect your deadlines; only a genuine tie asks you to choose."
    : "Surfaces every trade-off for you to apply — nothing is deferred automatically.";

  // Best recovered odds across the moves - the headline the batch buys.
  const best = triage.reduce((m, t) => Math.max(m, t.probabilityAfter), 0);

  // Auto mode: shed the lowest-value batch on sight, exactly once per mount.
  // The revalidated forecast then drops these tasks and the conflict usually
  // clears - we fall through to the receipt below.
  const autoFired = useRef(false);
  useEffect(() => {
    if (!autoOn || autoFired.current || triage.length === 0) return;
    autoFired.current = true;
    const ids = triage.map((m) => m.taskId);
    startTransition(async () => {
      await applyTriageAction(ids);
      setReceipt({ taskIds: ids });
    });
  }, [autoOn, triage]);

  function undo() {
    if (!receipt) return;
    const ids = receipt.taskIds;
    setUndoing(true);
    startTransition(async () => {
      await undoTriageAction(ids);
      setReceipt(null);
      // Let auto re-fire if the conflict returns after the work comes back.
      autoFired.current = false;
      setUndoing(false);
    });
  }

  return (
    <Card>
      <CardHeader
        title="The pit wall"
        icon={
          <TrafficCone
            className={cn(
              "size-4",
              hasConflict
                ? "text-[var(--color-danger)]"
                : "text-[var(--color-fg-muted)]",
            )}
          />
        }
        action={<StrategyToggle on={autoOn} onToggle={toggleStrategy} />}
      />
      <div className="p-3">
        <p className="mb-2.5 px-1 text-[12px] leading-snug text-[var(--color-fg-subtle)]">
          {modeDescription}
        </p>
        {hasConflict ? (
          <div className="rounded-lg border border-[var(--color-border)] border-l-2 border-l-[var(--color-danger)] bg-[var(--color-surface-raised)] p-4">
            {/* What the shared hours can't fit */}
            <div className="flex items-start gap-2.5">
              <TrafficCone className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[var(--color-fg)]">
                  {collision
                    ? "Two deadlines are fighting for the same hours"
                    : "This won't all fit before its deadline"}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {conflicts.map((c) => (
                    <li
                      key={c.projectId}
                      className="text-[12px] text-[var(--color-fg-muted)]"
                    >
                      {c.detail}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Auto path - shed the lowest-value doomed work. */}
            {triage.length > 0 &&
              (autoOn ? (
                <p className="mt-3.5 flex items-center gap-1.5 text-[12px] text-[var(--color-fg-muted)]">
                  <ArrowRight className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
                  Auto-deferring {triage.length} low-value{" "}
                  {triage.length === 1 ? "task" : "tasks"} →{" "}
                  <span
                    className={cn(
                      "font-semibold tabular-nums",
                      toneText(best),
                    )}
                  >
                    {formatPct(best)}
                  </span>
                </p>
              ) : (
                <ManualTriage triage={triage} />
              ))}

            {/* The one manual call - a genuine comparable-value tie. */}
            {needsDecision && options.length > 0 && (
              <Escalation options={options} />
            )}

            {/* Nothing auto can relieve, and no tie to arbitrate. */}
            {triage.length === 0 && !needsDecision && (
              <p className="mt-3.5 text-[12px] text-[var(--color-fg-muted)]">
                No low-value work to shed recovers this — add hours, move a
                deadline, or split the work in the projects below.
              </p>
            )}
          </div>
        ) : receipt ? (
          /* Auto-applied receipt - persists after the conflict clears, undoable. */
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-3">
            <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--color-fg-muted)]">
              <Check className="size-3.5 shrink-0 text-[var(--color-status-done)]" />
              <span className="min-w-0">
                Auto-deferred {receipt.taskIds.length} low-value{" "}
                {receipt.taskIds.length === 1 ? "task" : "tasks"} to protect your
                deadlines.
              </span>
            </p>
            <Button
              variant="ghost"
              size="sm"
              loading={undoing}
              disabled={pending}
              onClick={undo}
            >
              <Undo2 className="size-3.5" />
              Undo
            </Button>
          </div>
        ) : (
          /* Calm - everything fits. */
          <p className="flex items-center gap-1.5 px-1 py-0.5 text-[12px] text-[var(--color-fg-muted)]">
            <Shield className="size-3.5 shrink-0 text-[var(--color-status-done)]" />
            All projects fit your hours.
          </p>
        )}
      </div>
    </Card>
  );
}

/** The auto/manual switch, compact for the card header. State is owned by the parent so the
 *  switch and its description stay in lockstep. */
function StrategyToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span
        className={cn(
          "text-[11px] font-medium uppercase tracking-[0.05em]",
          on
            ? "text-[var(--color-accent-fg)]"
            : "text-[var(--color-fg-subtle)]",
        )}
      >
        {on ? "Auto" : "Manual"}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Pit-wall automation"
        onClick={onToggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
          on ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 transform rounded-full bg-white shadow-sm transition-transform",
            on ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

/** Manual mode: defer the lowest-WSJF doomed work, surfaced for a click - all at once or one at
 *  a time. Each shows the odds it recovers. Reversible from the project's Deferred section. */
function ManualTriage({ triage }: { triage: PitWall["triage"] }) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());

  const remaining = triage.filter((m) => !applied.has(m.taskId));
  const best = triage.reduce((m, t) => Math.max(m, t.probabilityAfter), 0);

  function defer(ids: string[], key: string) {
    setBusy(key);
    startTransition(async () => {
      // Always route through applyTriageAction - it splits real tasks from
      // `skill:` lanes, whereas deferTaskAction would no-op on a skill id.
      await applyTriageAction(ids);
      setApplied((s) => {
        const next = new Set(s);
        ids.forEach((id) => next.add(id));
        return next;
      });
      setBusy(null);
    });
  }

  if (remaining.length === 0) {
    return (
      <p className="mt-3.5 flex items-center gap-1.5 text-[12px] text-[var(--color-status-done)]">
        <Check className="size-3.5" /> Deferred — forecast updating.
      </p>
    );
  }

  return (
    <div className="mt-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
          Auto-fix — defer low-value work
        </p>
        <Button
          variant="secondary"
          size="sm"
          loading={busy === "all"}
          disabled={pending}
          onClick={() => defer(remaining.map((m) => m.taskId), "all")}
        >
          Defer {remaining.length} →{" "}
          <span className={cn("font-semibold tabular-nums", toneText(best))}>
            {formatPct(best)}
          </span>
        </Button>
      </div>
      <div className="mt-1.5 space-y-1.5">
        {remaining.map((m) => (
          <div
            key={m.taskId}
            className="flex items-center gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5"
          >
            <ArrowRight className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-muted)]">
              {m.title}
            </span>
            <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[var(--color-status-done)]">
              → {formatPct(m.probabilityAfter)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === m.taskId}
              disabled={pending}
              onClick={() => defer([m.taskId], m.taskId)}
            >
              Defer
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The escalated tie: two comparable-value projects collide and auto won't pick for you. Each
 *  option protects one by deferring the others' open work. Only one can win, so once one is
 *  applied the rest disappear. */
function Escalation({ options }: { options: PitWallOption[] }) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  function protect(opt: PitWallOption) {
    setBusy(opt.protectId);
    startTransition(async () => {
      await applyTriageAction(opt.sacrificeTaskIds);
      setChosen(opt.protectId);
      setBusy(null);
    });
  }

  if (chosen) {
    const picked = options.find((o) => o.protectId === chosen);
    return (
      <p className="mt-3.5 flex items-center gap-1.5 text-[12px] text-[var(--color-status-done)]">
        <Check className="size-3.5" /> Protecting {picked?.protectName} — the rest
        is deferred and reversible.
      </p>
    );
  }

  return (
    <div className="mt-3.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
        <Scale className="size-3.5" /> Your call — equally important, pick one
      </p>
      <div className="mt-1.5 space-y-1.5">
        {options.map((opt) => (
          <div
            key={opt.protectId}
            className="flex items-center gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5"
          >
            <Flag className="size-3.5 shrink-0 text-[var(--color-accent-fg)]" />
            <span className="min-w-0 flex-1 text-[12px] text-[var(--color-fg-muted)]">
              Protect{" "}
              <span className="text-[var(--color-fg)]">{opt.protectName}</span>
              <span className="text-[var(--color-fg-subtle)]">
                {" "}
                · defer {opt.sacrificeNames.join(", ")}
              </span>
            </span>
            <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[var(--color-status-done)]">
              → {formatPct(opt.probabilityAfter)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === opt.protectId}
              disabled={pending}
              onClick={() => protect(opt)}
            >
              <Shield className="size-3.5" />
              Protect
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
