"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, GraduationCap, Sparkles, Timer, Undo2 } from "lucide-react";
import {
  resolveSubsetCumulative,
  type ResolveInput,
} from "@/lib/portfolio-state";
import {
  commitStrategyBundleAction,
  logActualTimeAction,
  quickAddErrandAction,
  undoPlanVersionAction,
  type CheckinRunResult,
} from "@/lib/actions";
import { band, formatPct } from "@/components/forecast/forecast-meter";
import type { CheckinProposal } from "@/lib/types";
import { cn } from "@/lib/cn";

function toneText(p: number): string {
  const b = band(p);
  return b === "off"
    ? "text-[var(--color-danger)]"
    : b === "risk"
      ? "text-[var(--color-accent-fg)]"
      : "text-[var(--color-status-done)]";
}

/** A short label for the odds-silent Family-B rows — never a percentage (a 0% next
 *  to a log would mislead; the design keeps these visually distinct). */
function actionLabel(p: CheckinProposal): { icon: typeof Timer; text: string } {
  const a = p.action;
  if (a?.kind === "log_progress") return { icon: Timer, text: `Log ${a.minutes} min` };
  if (a?.kind === "capture_idea") return { icon: Sparkles, text: "Capture" };
  return { icon: Check, text: "Note" };
}

/**
 * The inline review surface for an interpreted check-in (§5.6 slice 5). Reuses the
 * S1 live-re-solve (`resolveSubsetCumulative`) for the odds-moving Family-A rows and
 * the S1 commit/undo (`commitStrategyBundleAction` / `undoPlanVersionAction`); the
 * odds-silent Family-B rows confirm captures/logs with no percentage. The whole
 * accepted Family-A set commits as ONE PlanVersion so Undo reverts it atomically.
 */
export function CheckinReview({
  result,
  onDone,
}: {
  result: CheckinRunResult;
  onDone: () => void;
}) {
  const { review, resolveInput } = result;
  const { proposals, chips } = review;

  // Included rows (by proposal index) — seeded from each proposal's defaultChecked
  // (high-confidence + resolved → on; ambiguous / inferred spillover → off).
  const [included, setIncluded] = useState<Set<number>>(
    () => new Set(proposals.flatMap((p, i) => (p.defaultChecked ? [i] : []))),
  );
  const [committed, setCommitted] = useState(false);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Live re-solve over the SELECTED Family-A moves (in row order), mirroring the
  // strategy card: each row shows the portfolio odds after it + everything before.
  const live = useMemo(() => {
    const seq = proposals
      .map((p, index) => ({ p, index }))
      .filter(({ p, index }) => p.family === "A" && p.move && included.has(index));
    const { afterEach, combined } = resolveSubsetCumulative(
      resolveInput as ResolveInput,
      seq.map((x) => x.p.move!),
    );
    const byIndex = new Map<number, number>();
    seq.forEach((x, i) => byIndex.set(x.index, afterEach[i]));
    return { byIndex, combined };
  }, [proposals, included, resolveInput]);

  function toggle(index: number) {
    setIncluded((s) => {
      const next = new Set(s);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const selected = proposals
    .map((p, index) => ({ p, index }))
    .filter(({ index }) => included.has(index));
  const familyA = selected.filter(({ p }) => p.family === "A" && p.move);
  const familyB = selected.filter(({ p }) => p.family === "B" && p.action);
  const total = selected.length;

  function apply() {
    if (total === 0 || pending) return;
    const movesA = familyA.map(({ p }) => p.move!);
    startTransition(async () => {
      let newVersionId: string | null = null;
      if (movesA.length > 0) {
        const before = resolveSubsetCumulative(resolveInput, []).combined;
        const after = resolveSubsetCumulative(resolveInput, movesA).combined;
        const version = await commitStrategyBundleAction(
          movesA,
          before,
          after,
          `Check-in: ${movesA.length} update${movesA.length === 1 ? "" : "s"}`,
        );
        newVersionId = version.id;
      }
      // Family-B actions are odds-silent + idempotent — run individually (log SETs
      // time, capture adds an errand); they ride outside the undoable bundle.
      for (const { p } of familyB) {
        const a = p.action!;
        if (a.kind === "log_progress") await logActualTimeAction(a.taskId, a.minutes);
        else if (a.kind === "capture_idea") await quickAddErrandAction(a.text, null);
      }
      setVersionId(newVersionId);
      setCommitted(true);
    });
  }

  function undo() {
    if (!versionId || pending) return;
    startTransition(async () => {
      await undoPlanVersionAction(versionId);
      setVersionId(null);
      setCommitted(false);
    });
  }

  if (committed) {
    return (
      <div className="flex items-center justify-between rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3.5 shadow-[var(--shadow-md)]">
        <span className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
          <Check className="size-4 text-[var(--color-status-done)]" aria-hidden />
          Logged {total} update{total === 1 ? "" : "s"}.
        </span>
        <span className="flex items-center gap-3">
          {versionId && (
            <button
              type="button"
              onClick={undo}
              disabled={pending}
              className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] disabled:opacity-50"
            >
              <Undo2 className="size-3.5" aria-hidden />
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={onDone}
            className="text-[13px] font-medium text-[var(--color-accent-fg)] hover:underline"
          >
            Done
          </button>
        </span>
      </div>
    );
  }

  const hasAnything = proposals.length > 0 || chips.length > 0;

  return (
    <div className="rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <span className="text-[13px] font-semibold text-[var(--color-fg)]">
          {hasAnything ? "Here's what I caught" : "Nothing to act on"}
        </span>
        <span className="text-[11px] text-[var(--color-fg-subtle)]">
          {result.source === "llm" ? "Interpreted" : "Quick read"}
        </span>
      </div>

      <ul className="divide-y divide-[var(--color-border)]">
        {proposals.map((p, index) => {
          const checked = included.has(index);
          const isA = p.family === "A" && !!p.move;
          const odds = isA ? live.byIndex.get(index) : undefined;
          const label = !isA ? actionLabel(p) : null;
          const ambiguous = p.resolved.status === "ambiguous";
          return (
            <li key={index} className="flex items-start gap-3 px-4 py-3">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(index)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                aria-label={`Include: ${p.move?.rationale ?? label?.text ?? "update"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium text-[var(--color-fg)]">
                  {p.move?.rationale ??
                    (p.action?.kind === "capture_idea"
                      ? `Capture "${p.action.text}"`
                      : p.action?.kind === "log_progress"
                        ? `Log ${p.action.minutes} min on "${p.action.title}"`
                        : "Noted")}
                </span>
                <span className="mt-0.5 block truncate text-[12px] italic text-[var(--color-fg-subtle)]">
                  &ldquo;{p.resolved.intent.quote}&rdquo;
                </span>
                {ambiguous && (
                  <span className="mt-1 block text-[11px] text-[var(--color-accent-fg)]">
                    Ambiguous — {p.resolved.candidates.map((c) => c.title).join(" or ")}
                  </span>
                )}
              </span>
              {isA && odds !== undefined ? (
                <span className={cn("shrink-0 text-[13px] font-semibold tabular-nums", checked ? toneText(odds) : "text-[var(--color-fg-subtle)]")}>
                  → {formatPct(odds)}
                </span>
              ) : label ? (
                <span className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-fg-subtle)]">
                  <label.icon className="size-3.5" aria-hidden />
                  {label.text}
                </span>
              ) : null}
            </li>
          );
        })}

        {chips.length > 0 && (
          <li className="flex flex-wrap gap-2 px-4 py-3">
            {chips.map((c, i) => (
              <span
                key={i}
                className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-fg-subtle)]"
                title={c.status === "unresolved" ? "Couldn't match this to anything open" : "Acknowledged"}
              >
                {c.status === "unresolved" ? "Couldn't match: " : ""}
                &ldquo;{c.intent.quote}&rdquo;
              </span>
            ))}
          </li>
        )}
      </ul>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-3">
        <button
          type="button"
          onClick={onDone}
          className="text-[13px] font-medium text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={total === 0 || pending}
          className="flex items-center gap-1.5 rounded-[10px] bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--color-bg)] disabled:opacity-40"
        >
          <GraduationCap className="size-4" aria-hidden />
          {pending ? "Applying…" : total === 0 ? "Nothing selected" : `Apply ${total} update${total === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
