"use client";

import { useState, useTransition } from "react";
import {
  ArrowRight,
  Check,
  Flag,
  Scale,
  Shield,
  TrafficCone,
} from "lucide-react";
import type { PitWall } from "@/lib/store";
import type { PitWallOption } from "@/lib/types";
import { applyTriageAction, deferTaskAction } from "@/lib/actions";
import { band, formatPct } from "@/components/forecast/forecast-meter";
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

/**
 * The pit wall: the bird's-eye view of what the shared hours can't satisfy and
 * the cross-project trade-off to make. Two paths, matching locked decision #3:
 * an auto recovery (shed the lowest-value doomed work — one click) and, only
 * when the engine hit a genuine comparable-value tie, an escalation where the
 * user picks which colliding project to protect. Both reuse the reversible
 * defer, so every move is undoable from the project's Deferred section.
 */
export function PitWallCallout({ pitWall }: { pitWall: PitWall }) {
  const { conflicts, triage, needsDecision, options } = pitWall;
  const collision = conflicts.some((c) => c.kind === "deadline_collision");

  return (
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
              <li key={c.projectId} className="text-[12px] text-[var(--color-fg-muted)]">
                {c.detail}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Auto path — shed the lowest-value doomed work. */}
      {triage.length > 0 && <AutoTriage triage={triage} />}

      {/* The one manual call — a genuine comparable-value tie. */}
      {needsDecision && options.length > 0 && <Escalation options={options} />}

      {/* Nothing auto can relieve, and no tie to arbitrate — name the levers. */}
      {triage.length === 0 && !needsDecision && (
        <p className="mt-3.5 text-[12px] text-[var(--color-fg-muted)]">
          No low-value work to shed recovers this — add hours, move a deadline, or
          split the work in the projects below.
        </p>
      )}
    </div>
  );
}

/** Defer the lowest-WSJF doomed work — all at once, or one task at a time. */
function AutoTriage({ triage }: { triage: PitWall["triage"] }) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());

  const remaining = triage.filter((m) => !applied.has(m.taskId));
  // Best recovered odds across the moves — the headline the batch buys.
  const best = triage.reduce((m, t) => Math.max(m, t.probabilityAfter), 0);

  function defer(ids: string[], key: string) {
    setBusy(key);
    startTransition(async () => {
      await (ids.length === 1
        ? deferTaskAction(ids[0], true)
        : applyTriageAction(ids));
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

/**
 * The escalated tie: two comparable-value projects collide and auto won't pick
 * for you. Each option protects one by deferring the others' open work; choosing
 * it batch-defers the sacrifice set. Only one can win, so once one is applied the
 * rest disappear.
 */
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
              Protect <span className="text-[var(--color-fg)]">{opt.protectName}</span>
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
